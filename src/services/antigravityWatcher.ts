import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HistoryStorageService } from './historyStorage.js';
import { PromptMetadata } from '../types.js';

export class AntigravityWatcherService implements vscode.Disposable {
  private _disposables: vscode.Disposable[] = [];
  private _watchers = new Map<string, fs.FSWatcher>();
  private _pollTimer?: NodeJS.Timeout;
  private _processedEntries = new Set<string>();
  private _fileOffsets = new Map<string, number>();
  private _knownConvs = new Set<string>();
  private _active = false;

  constructor(private readonly _storageService: HistoryStorageService) {}

  /**
   * Start the Antigravity transcript watcher
   */
  public async start(): Promise<void> {
    const config = this._storageService.getConfig();
    if (!config.enabled || !config.antigravityAutoCapture) {
      console.log('[AI Prompt Logger] Antigravity auto capture is disabled.');
      return;
    }

    if (this._active) {
      return;
    }
    this._active = true;
    console.log('[AI Prompt Logger] Starting Antigravity transcript watcher...');

    // 1. Initial scan of existing transcripts
    await this.scanRecentTranscripts();

    // 2. Setup directory watchers and polling for real-time capture
    this.setupWatchers();

    // 3. Periodic poll to discover new conversation directories & catch file updates
    this._pollTimer = setInterval(async () => {
      try {
        await this.checkNewConversationsAndUpdates();
      } catch (err) {
        console.error('[AI Prompt Logger] Error polling Antigravity transcripts:', err);
      }
    }, 2000);
  }

  /**
   * Stop watching transcripts
   */
  public stop(): void {
    this._active = false;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = undefined;
    }

    for (const watcher of this._watchers.values()) {
      try {
        watcher.close();
      } catch {
        // Ignore close error
      }
    }
    this._watchers.clear();
    this._fileOffsets.clear();
    console.log('[AI Prompt Logger] Antigravity transcript watcher stopped.');
  }

  /**
   * Discovers possible Antigravity brain directories on the machine
   */
  public getBrainDirectories(): string[] {
    const dirs: string[] = [];
    const config = this._storageService.getConfig();

    // 1. Custom configured path
    if (config.antigravityBrainPath && config.antigravityBrainPath.trim()) {
      const customPath = config.antigravityBrainPath.trim();
      if (fs.existsSync(customPath)) {
        dirs.push(customPath);
      }
    }

    // 2. Standard user home .gemini directories
    const homeDir = os.homedir();
    const candidatePaths = [
      path.join(homeDir, '.gemini', 'antigravity-ide', 'brain'),
      path.join(homeDir, '.gemini', 'antigravity', 'brain'),
      path.join(homeDir, '.gemini', 'antigravity-cli', 'brain'),
      path.join(homeDir, '.gemini', 'brain'),
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p) && !dirs.includes(p)) {
        dirs.push(p);
      }
    }

    // 3. Workspace-scoped directories
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      for (const folder of workspaceFolders) {
        const wsCandidate = path.join(folder.uri.fsPath, '.gemini', 'brain');
        if (fs.existsSync(wsCandidate) && !dirs.includes(wsCandidate)) {
          dirs.push(wsCandidate);
        }
      }
    }

    return dirs;
  }

  /**
   * Initial scan to catch any recent user prompts from today / current session
   */
  private async scanRecentTranscripts(): Promise<void> {
    const brainDirs = this.getBrainDirectories();
    const now = Date.now();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    for (const brainDir of brainDirs) {
      try {
        const entries = await fs.promises.readdir(brainDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) {
            continue;
          }

          const convId = entry.name;
          const convDir = path.join(brainDir, convId);
          this._knownConvs.add(convDir);

          const transcriptPath = path.join(convDir, '.system_generated', 'logs', 'transcript.jsonl');
          try {
            if (fs.existsSync(transcriptPath)) {
              const stat = await fs.promises.stat(transcriptPath);
              // Directly check transcript file mtime (fixing Windows NTFS directory mtime issue)
              if (now - stat.mtimeMs < SEVEN_DAYS_MS) {
                await this.processTranscriptFile(transcriptPath, convId, true);
              }
            }
          } catch {
            // Ignore stat errors for individual files
          }
        }
      } catch (err) {
        console.warn(`[AI Prompt Logger] Failed to read brain directory: ${brainDir}`, err);
      }
    }
  }

  /**
   * Setup watchers on brain directories and active transcripts
   */
  private setupWatchers(): void {
    const brainDirs = this.getBrainDirectories();
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    for (const brainDir of brainDirs) {
      if (this._watchers.has(brainDir)) {
        continue;
      }

      try {
        // Recursive watching on Windows/macOS ensures modifications to nested transcript.jsonl trigger events
        const watcher = fs.watch(
          brainDir,
          { recursive: isWindows || isMac },
          async (_eventType, _filename) => {
            await this.checkNewConversationsAndUpdates();
          }
        );

        watcher.on('error', (err) => {
          console.warn(`[AI Prompt Logger] Brain directory watcher error:`, err);
        });

        this._watchers.set(brainDir, watcher);
      } catch (err) {
        console.warn(`[AI Prompt Logger] Could not attach fs.watch to: ${brainDir}`, err);
      }
    }
  }

  /**
   * Check for new conversation directories and process modified transcript files
   */
  private async checkNewConversationsAndUpdates(): Promise<void> {
    if (!this._active) {
      return;
    }

    const brainDirs = this.getBrainDirectories();
    const now = Date.now();
    const TEN_MINUTES_MS = 10 * 60 * 1000;

    for (const brainDir of brainDirs) {
      try {
        const entries = await fs.promises.readdir(brainDir, { withFileTypes: true });

        for (const entry of entries) {
          if (!entry.isDirectory()) {
            continue;
          }

          const convId = entry.name;
          const convDir = path.join(brainDir, convId);
          const logsDir = path.join(convDir, '.system_generated', 'logs');
          const transcriptPath = path.join(logsDir, 'transcript.jsonl');

          // If transcript exists, process if size changed or modified recently
          if (fs.existsSync(transcriptPath)) {
            try {
              const stat = await fs.promises.stat(transcriptPath);
              const knownOffset = this._fileOffsets.get(transcriptPath);
              if (
                knownOffset === undefined ||
                stat.size > knownOffset ||
                now - stat.mtimeMs < TEN_MINUTES_MS
              ) {
                await this.processTranscriptFile(transcriptPath, convId, false);
              }
            } catch {
              // Ignore stat error
            }
          }
        }
      } catch {
        // Ignore read errors
      }
    }
  }

  private _convProjectMap = new Map<string, vscode.Uri>();

  /**
   * Helper to find the project root directory given a file or folder path.
   * Walks up the filesystem hierarchy looking for marker files/folders like .git, package.json, etc.
   */
  public findProjectRoot(initialPath: string): string | null {
    try {
      let current = path.resolve(initialPath);
      if (!fs.existsSync(current)) {
        return null;
      }
      const stat = fs.statSync(current);
      if (!stat.isDirectory()) {
        current = path.dirname(current);
      }

      const markers = [
        '.git',
        '.prompt-history.json',
        'package.json',
        'tsconfig.json',
        'pyproject.toml',
        'Cargo.toml',
        'go.mod',
        'pom.xml',
        '.vscode',
      ];

      let checkDir = current;
      let rootWithMarker: string | null = null;

      // Check upwards up to 10 levels
      for (let i = 0; i < 10; i++) {
        for (const marker of markers) {
          if (fs.existsSync(path.join(checkDir, marker))) {
            rootWithMarker = checkDir;
            break;
          }
        }
        if (rootWithMarker) {
          return rootWithMarker;
        }
        const parent = path.dirname(checkDir);
        if (parent === checkDir) {
          break; // Reached root of drive/filesystem
        }
        checkDir = parent;
      }

      // If no marker found, return the directory itself if it exists
      return current;
    } catch {
      return null;
    }
  }

  /**
   * Extracts workspace directory paths from <user_information> block or raw content
   */
  public extractWorkspacePaths(rawContent: string): string[] {
    const paths: string[] = [];

    // 1. Look inside <user_information>...</user_information>
    const userInfoMatch = rawContent.match(/<user_information>([\s\S]*?)<\/user_information>/i);
    if (userInfoMatch) {
      const userInfoText = userInfoMatch[1];
      const lines = userInfoText.split(/\r?\n/);
      let inWorkspacesSection = false;

      for (const line of lines) {
        const trimmed = line.trim();
        if (/active workspaces/i.test(trimmed)) {
          inWorkspacesSection = true;
          continue;
        }

        if (inWorkspacesSection) {
          if (/^(?:Code relating to|App Data Directory|Conversation ID|<\/user_information>)/i.test(trimmed)) {
            inWorkspacesSection = false;
            continue;
          }

          // Format: [URI] -> [CorpusName] or URI -> CorpusName
          const mapMatch = trimmed.match(/^(?:\[([^\]]+)\]|([^->\r\n]+?))\s*->\s*(?:\[([^\]]+)\]|([^\r\n]+))$/);
          if (mapMatch) {
            const rawPath = (mapMatch[1] || mapMatch[2] || '').trim();
            if (rawPath) {
              const cleanPath = rawPath.replace(/^file:\/\/\/?/i, '');
              if (cleanPath && !cleanPath.includes('LANGUAGE_UNSPECIFIED')) {
                paths.push(cleanPath);
              }
            }
          } else if (trimmed && !trimmed.includes('format [URI]') && !trimmed.includes('The mapping is shown')) {
            const cleanPath = trimmed.replace(/^file:\/\/\/?/i, '');
            if (cleanPath && (cleanPath.includes('/') || cleanPath.includes('\\'))) {
              paths.push(cleanPath);
            }
          }
        }
      }

      // Fallback: search for any URI -> CorpusName in user_information
      if (paths.length === 0) {
        const genericMapMatches = userInfoText.matchAll(/([a-zA-Z]:\\[^->\r\n]+|\/[^->\r\n]+)\s*->/g);
        for (const m of genericMapMatches) {
          if (m[1] && m[1].trim()) {
            paths.push(m[1].trim());
          }
        }
      }
    }

    return paths;
  }

  /**
   * Resolves the target project folder URI for a given conversation.
   * Ensures prompts are saved to that exact project's file, NEVER randomly dumping into the currently opened project.
   */
  public async resolveConversationProjectUri(
    conversationId: string,
    rawContent: string,
    transcriptPath: string
  ): Promise<vscode.Uri | null> {
    // 1. Check memory cache first
    const cached = this._convProjectMap.get(conversationId);
    if (cached) {
      return cached;
    }

    const cleanPathCandidate = (raw: string): string => {
      let s = raw.trim();
      s = s.replace(/^\\?["']|\\?["']$/g, '');
      s = s.replace(/\\\\/g, '\\');
      s = s.replace(/^file:\/\/\/?/i, '');
      return s.trim();
    };

    const candidatePaths: string[] = [];

    // 2. Extract from <user_information> in current entry
    candidatePaths.push(...this.extractWorkspacePaths(rawContent));

    // 3. Extract from Active Document: in current entry
    const docMatch = rawContent.match(/Active Document:\s*([^\r\n(]+)/i);
    if (docMatch) {
      const docPath = docMatch[1].trim();
      if (docPath && !docPath.includes('LANGUAGE_UNSPECIFIED')) {
        candidatePaths.push(docPath);
      }
    }

    // 4. Extract from tool paths / file links in current entry
    const propMatches = rawContent.matchAll(
      /"(?:Cwd|TargetFile|AbsolutePath|SearchPath|DirectoryPath)"\s*:\s*\\?"([^"\r\n]+?)\\?"/g
    );
    for (const m of propMatches) {
      if (m[1]) {
        candidatePaths.push(cleanPathCandidate(m[1]));
      }
    }

    // 5. If no candidate found in current line, scan lines of the transcript file
    if (candidatePaths.length === 0 && transcriptPath && fs.existsSync(transcriptPath)) {
      try {
        const fileData = await fs.promises.readFile(transcriptPath, 'utf8');
        const lines = fileData.split('\n').slice(0, 100).join('\n');
        candidatePaths.push(...this.extractWorkspacePaths(lines));

        const earlyDocMatch = lines.match(/Active Document:\s*([^\r\n(]+)/i);
        if (earlyDocMatch) {
          candidatePaths.push(earlyDocMatch[1].trim());
        }

        const earlyPropMatches = lines.matchAll(
          /"(?:Cwd|TargetFile|AbsolutePath|SearchPath|DirectoryPath)"\s*:\s*\\?"([^"\r\n]+?)\\?"/g
        );
        for (const m of earlyPropMatches) {
          if (m[1]) {
            candidatePaths.push(cleanPathCandidate(m[1]));
          }
        }
      } catch {
        // Ignore file read error
      }
    }

    // 6. Test candidates and find the existing project root
    for (const rawCandidate of candidatePaths) {
      const cleanCandidate = cleanPathCandidate(rawCandidate);
      if (!cleanCandidate) {
        continue;
      }

      const root = this.findProjectRoot(cleanCandidate);
      if (root && fs.existsSync(root)) {
        // Match against open VS Code workspace folders if identical path
        const workspaceFolders = vscode.workspace.workspaceFolders;
        let matchedUri: vscode.Uri | null = null;
        if (workspaceFolders) {
          const normRoot = root.replace(/\\/g, '/').toLowerCase();
          for (const folder of workspaceFolders) {
            const normWs = folder.uri.fsPath.replace(/\\/g, '/').toLowerCase();
            if (normRoot === normWs || normRoot.startsWith(normWs + '/')) {
              matchedUri = folder.uri;
              break;
            }
          }
        }

        const finalUri = matchedUri || vscode.Uri.file(root);
        this._convProjectMap.set(conversationId, finalUri);
        return finalUri;
      }
    }

    // 7. Fallback: If no explicit path discovered in transcript, use active VS Code workspace folder
    if (vscode.window.activeTextEditor) {
      const match = vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
      if (match) {
        this._convProjectMap.set(conversationId, match.uri);
        return match.uri;
      }
    }

    const openFolders = vscode.workspace.workspaceFolders;
    if (openFolders && openFolders.length > 0) {
      this._convProjectMap.set(conversationId, openFolders[0].uri);
      return openFolders[0].uri;
    }

    return null;
  }

  /**
   * Reads and parses newly added lines from a transcript.jsonl file
   */
  private async processTranscriptFile(
    transcriptPath: string,
    conversationId: string,
    isStartupScan: boolean
  ): Promise<void> {
    try {
      const stat = await fs.promises.stat(transcriptPath);
      const currentOffset = this._fileOffsets.get(transcriptPath) || 0;

      // If file has not grown, skip
      if (currentOffset >= stat.size && !isStartupScan) {
        return;
      }

      // Read file content
      const content = await fs.promises.readFile(transcriptPath, 'utf8');
      this._fileOffsets.set(transcriptPath, stat.size);

      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) {
          continue;
        }

        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'USER_INPUT') {
            await this.handleUserInputEntry(parsed, conversationId, transcriptPath, isStartupScan);
          }
        } catch {
          // Skip malformed individual lines
        }
      }
    } catch (err) {
      console.warn(`[AI Prompt Logger] Failed to process transcript ${transcriptPath}:`, err);
    }
  }

  /**
   * Handles a parsed USER_INPUT JSON record from Antigravity transcript
   */
  private async handleUserInputEntry(
    entry: {
      step_index?: number;
      source?: string;
      type?: string;
      created_at?: string;
      content?: string | { parts?: unknown[] };
    },
    conversationId: string,
    transcriptPath: string,
    _isStartupScan: boolean
  ): Promise<void> {
    const rawContent =
      typeof entry.content === 'string'
        ? entry.content
        : JSON.stringify(entry.content || '');

    if (!rawContent || !rawContent.trim()) {
      return;
    }

    // 1. Extract the user prompt
    let promptText = rawContent;
    const reqMatch = rawContent.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
    if (reqMatch) {
      promptText = reqMatch[1].trim();
    } else {
      // Strip metadata blocks if present
      promptText = rawContent
        .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
        .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
        .replace(/<user_information>[\s\S]*?<\/user_information>/gi, '')
        .replace(/<conversation_history>[\s\S]*?<\/conversation_history>/gi, '')
        .replace(/<conversation_summaries>[\s\S]*?<\/conversation_summaries>/gi, '')
        .replace(/<system_message>[\s\S]*?<\/system_message>/gi, '')
        .trim();
    }

    if (!promptText) {
      return;
    }

    const stepIndex = entry.step_index ?? 0;
    const timestamp = entry.created_at || new Date().toISOString();
    const dedupeKey = `${conversationId}_${stepIndex}_${timestamp}`;

    if (this._processedEntries.has(dedupeKey)) {
      return;
    }
    this._processedEntries.add(dedupeKey);

    // 2. Extract contextual metadata
    let activeFilePath: string | undefined;
    let activeFile: string | undefined;
    let cursorLine: number | undefined;
    let modelName: string | undefined;

    // Active Document
    const docMatch = rawContent.match(/Active Document:\s*([^\r\n(]+)/i);
    if (docMatch) {
      const rawDocPath = docMatch[1].trim();
      if (rawDocPath && !rawDocPath.includes('LANGUAGE_UNSPECIFIED')) {
        activeFilePath = rawDocPath;
        const parts = rawDocPath.split(/[/\\]/);
        activeFile = parts[parts.length - 1];
      }
    }

    // Cursor line
    const lineMatch = rawContent.match(/Cursor is on line:\s*(\d+)/i);
    if (lineMatch) {
      cursorLine = parseInt(lineMatch[1], 10);
    }

    // Model selection
    const modelMatch = rawContent.match(/Model Selection`?\s*from\s*\S+\s*to\s*(.*?)(?:\.\s*No need|\.\s*If reporting|\r?\n|$)/i);
    if (modelMatch && modelMatch[1]) {
      modelName = modelMatch[1].replace(/\.$/, '').trim();
    } else {
      modelName = 'Antigravity AI';
    }

    // 3. Resolve exact target project folder for this conversation
    let targetFolder = await this.resolveConversationProjectUri(
      conversationId,
      rawContent,
      transcriptPath
    );

    if (!targetFolder) {
      if (vscode.window.activeTextEditor) {
        const match = vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
        if (match) {
          targetFolder = match.uri;
        }
      }
      if (!targetFolder && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        targetFolder = vscode.workspace.workspaceFolders[0].uri;
      }
    }

    if (!targetFolder) {
      console.log(
        `[AI Prompt Logger] Skipping prompt (conv: ${conversationId}, step: ${stepIndex}): No workspace folder open.`
      );
      return;
    }

    // 4. Check if already exists in history file to avoid duplicate logging
    const existing = await this._storageService.readHistory(targetFolder);
    const alreadyLogged = existing.some(
      (e) =>
        (e.metadata?.conversationId === conversationId &&
          e.metadata?.stepIndex === stepIndex) ||
        (e.prompt === promptText && e.timestamp === timestamp)
    );
    if (alreadyLogged) {
      return;
    }

    // 5. Construct metadata with accurate relative paths and project name
    let relativeFilePath = activeFilePath;
    if (activeFilePath && targetFolder) {
      try {
        const normTarget = targetFolder.fsPath;
        const rel = path.relative(normTarget, activeFilePath).replace(/\\/g, '/');
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
          relativeFilePath = rel;
        }
      } catch {
        // Keep original if path.relative fails
      }
    }

    const metadata: PromptMetadata = {
      source: 'antigravity',
      model: modelName,
      activeFile: activeFile,
      activeFilePath: relativeFilePath,
      conversationId,
      stepIndex,
      workspaceName: path.basename(targetFolder.fsPath),
    };

    if (cursorLine) {
      metadata.selection = {
        startLine: cursorLine,
        endLine: cursorLine,
        startCharacter: 1,
        endCharacter: 1,
      };
    }

    // 6. Log the prompt into that same project's .prompt-history.json
    console.log(
      `[AI Prompt Logger] Auto-capturing Antigravity prompt for project "${targetFolder.fsPath}" (conv: ${conversationId}, step: ${stepIndex}): "${promptText.slice(0, 50)}..."`
    );
    await this._storageService.logPrompt(promptText, {
      source: 'antigravity',
      modelName,
      metadata,
      workspaceFolderUri: targetFolder,
    });
  }

  public dispose(): void {
    this.stop();
    this._convProjectMap.clear();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
