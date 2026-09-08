import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { PromptHistoryEntry, PromptMetadata, LoggerConfig, PromptStats } from '../types.js';
import { AsyncLock } from '../utils/mutex.js';
import { ensureGitignored } from '../utils/gitignore.js';
import { captureEditorMetadata } from '../utils/metadata.js';

export class HistoryStorageService {
  private lock = new AsyncLock();
  private _onDidChangeHistory = new vscode.EventEmitter<PromptHistoryEntry[]>();
  public readonly onDidChangeHistory: vscode.Event<PromptHistoryEntry[]> =
    this._onDidChangeHistory.event;

  /**
   * Get current configuration settings
   */
  public getConfig(): LoggerConfig {
    const config = vscode.workspace.getConfiguration('aiPromptLogger');
    return {
      enabled: config.get<boolean>('enabled', true),
      fileName: config.get<string>('fileName', '.ai/history.json'),
      autoGitignore: config.get<boolean>('autoGitignore', true),
      captureMetadata: config.get<boolean>('captureMetadata', true),
      maxEntries: config.get<number>('maxEntries', 1000),
      notifyOnLog: config.get<boolean>('notifyOnLog', false),
      antigravityAutoCapture: config.get<boolean>('antigravityAutoCapture', true),
      antigravityBrainPath: config.get<string>('antigravityBrainPath', ''),
    };
  }

  /**
   * Helper to ensure parent directory exists before writing to a file URI
   */
  private async ensureParentDirectory(fileUri: vscode.Uri): Promise<void> {
    try {
      const parentUri = vscode.Uri.joinPath(fileUri, '..');
      await vscode.workspace.fs.createDirectory(parentUri);
    } catch {
      // Ignore if directory already exists
    }
  }

  /**
   * Resolves target log file URI for a given workspace folder.
   */
  public getLogUri(workspaceFolderUri?: vscode.Uri): vscode.Uri | null {
    const targetFolder =
      workspaceFolderUri ||
      (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]?.uri);

    if (!targetFolder) {
      return null;
    }

    const config = this.getConfig();
    let fileName = config.fileName.trim() || '.ai/history.json';
    fileName = fileName.replace(/\\/g, '/').replace(/^\/+/, '');
    const segments = fileName.split('/').filter(Boolean);
    return vscode.Uri.joinPath(targetFolder, ...segments);
  }

  /**
   * Read all prompt history entries safely from workspace.
   */
  public async readHistory(workspaceFolderUri?: vscode.Uri): Promise<PromptHistoryEntry[]> {
    const targetFolder =
      workspaceFolderUri ||
      (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]?.uri);

    const logUri = this.getLogUri(workspaceFolderUri);
    if (!logUri || !targetFolder) {
      return [];
    }

    try {
      const fileBytes = await vscode.workspace.fs.readFile(logUri);
      const rawContent = Buffer.from(fileBytes).toString('utf8').trim();

      if (!rawContent) {
        return [];
      }

      const parsed = JSON.parse(rawContent);
      if (Array.isArray(parsed)) {
        return parsed as PromptHistoryEntry[];
      } else {
        console.warn('[AI Prompt Logger] History file did not contain a JSON array, recovering...');
        await this.handleCorruptFile(logUri, rawContent);
        return [];
      }
    } catch (err: unknown) {
      const isNotFound =
        err instanceof vscode.FileSystemError &&
        (err.code === 'FileNotFound' || err.code === 'EntryNotFound');

      if (isNotFound || (err as { code?: string })?.code === 'FileNotFound') {
        // Check for legacy files to migrate (.ai/prompt-history.json, .prompt-history.json)
        const legacyUris = [
          vscode.Uri.joinPath(targetFolder, '.ai', 'prompt-history.json'),
          vscode.Uri.joinPath(targetFolder, '.prompt-history.json'),
        ];
        for (const legUri of legacyUris) {
          if (legUri.toString() === logUri.toString()) {
            continue;
          }
          try {
            const legBytes = await vscode.workspace.fs.readFile(legUri);
            const legContent = Buffer.from(legBytes).toString('utf8').trim();
            if (legContent) {
              const parsed = JSON.parse(legContent);
              if (Array.isArray(parsed) && parsed.length > 0) {
                // Auto-migrate to current logUri
                await this.ensureParentDirectory(logUri);
                await vscode.workspace.fs.writeFile(
                  logUri,
                  Buffer.from(JSON.stringify(parsed, null, 2) + '\n', 'utf8')
                );
                console.log(
                  `[AI Prompt Logger] Migrated ${parsed.length} entries from legacy ${legUri.fsPath} to ${logUri.fsPath}`
                );
                return parsed as PromptHistoryEntry[];
              }
            }
          } catch {
            // Legacy file not found, continue
          }
        }
        return [];
      }

      if (err instanceof SyntaxError) {
        console.error('[AI Prompt Logger] Malformed JSON detected. Backing up and resetting.', err);
        try {
          const fileBytes = await vscode.workspace.fs.readFile(logUri);
          await this.handleCorruptFile(logUri, Buffer.from(fileBytes).toString('utf8'));
        } catch {
          // Ignore backup read failure
        }
        return [];
      }

      console.error('[AI Prompt Logger] Error reading history file:', err);
      return [];
    }
  }

  /**
   * Backup corrupted history file and initialize clean log
   */
  private async handleCorruptFile(logUri: vscode.Uri, content: string): Promise<void> {
    try {
      await this.ensureParentDirectory(logUri);
      const backupUri = vscode.Uri.parse(`${logUri.toString()}.corrupt.${Date.now()}.bak`);
      await vscode.workspace.fs.writeFile(backupUri, Buffer.from(content, 'utf8'));
      await vscode.workspace.fs.writeFile(logUri, Buffer.from('[]\n', 'utf8'));
      vscode.window.showWarningMessage(
        `[AI Prompt Logger] Corrupted log file was backed up to ${backupUri.path.split('/').pop()}`
      );
    } catch (e) {
      console.error('[AI Prompt Logger] Failed to backup corrupted file:', e);
    }
  }

  /**
   * Append a new prompt entry to the history file.
   */
  public async logPrompt(
    promptText: string,
    options?: {
      metadata?: Partial<PromptMetadata>;
      workspaceFolderUri?: vscode.Uri;
      source?: PromptMetadata['source'];
      modelName?: string;
      chatCommand?: string;
    }
  ): Promise<PromptHistoryEntry | null> {
    const config = this.getConfig();
    if (!config.enabled) {
      return null;
    }

    const trimmedPrompt = promptText.trim();
    if (!trimmedPrompt) {
      return null;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    let targetFolder = options?.workspaceFolderUri;
    if (!targetFolder) {
      if (vscode.window.activeTextEditor) {
        const match = vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
        if (match) {
          targetFolder = match.uri;
        }
      }
      if (!targetFolder && workspaceFolders && workspaceFolders.length > 0) {
        targetFolder = workspaceFolders[0].uri;
      }
    }

    if (!targetFolder) {
      vscode.window.showWarningMessage(
        'AI Prompt Logger: No open workspace folder found to store prompt history.'
      );
      return null;
    }

    return this.lock.runExclusive(async () => {
      // 1. Auto-manage .gitignore if enabled
      if (config.autoGitignore) {
        await ensureGitignored(targetFolder, config.fileName);
      }

      // 2. Gather context metadata
      let fullMetadata: PromptMetadata = {};
      if (options?.source === 'antigravity') {
        fullMetadata = {
          source: 'antigravity',
          model: options?.modelName || 'Antigravity AI',
          ...(options?.metadata || {}),
        };
      } else if (config.captureMetadata) {
        const captured = await captureEditorMetadata({
          source: options?.source || 'command',
          modelName: options?.modelName,
          chatCommand: options?.chatCommand,
        });
        fullMetadata = { ...captured, ...(options?.metadata || {}) };
      } else {
        fullMetadata = {
          source: options?.source || 'command',
          model: options?.modelName || 'default',
          ...(options?.metadata || {}),
        };
      }

      // 3. Construct new entry with unique ID
      const newEntry: PromptHistoryEntry = {
        id: crypto.randomUUID ? crypto.randomUUID() : `prompt-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        timestamp: new Date().toISOString(),
        prompt: trimmedPrompt,
        metadata: fullMetadata,
      };

      // 4. Read current history
      const currentHistory = await this.readHistory(targetFolder);

      // 5. Append and apply maxEntries
      let updatedHistory = [...currentHistory, newEntry];
      if (config.maxEntries > 0 && updatedHistory.length > config.maxEntries) {
        // Keep the newest maxEntries
        updatedHistory = updatedHistory.slice(updatedHistory.length - config.maxEntries);
      }

      // 6. Asynchronous Write
      const logUri = this.getLogUri(targetFolder);
      if (!logUri) {
        return null;
      }

      await this.ensureParentDirectory(logUri);
      const jsonString = JSON.stringify(updatedHistory, null, 2) + '\n';
      await vscode.workspace.fs.writeFile(logUri, Buffer.from(jsonString, 'utf8'));

      // 7. Fire update event
      this._onDidChangeHistory.fire(updatedHistory);

      // 8. Optional notification
      if (config.notifyOnLog) {
        const preview =
          trimmedPrompt.length > 40
            ? `${trimmedPrompt.substring(0, 40)}...`
            : trimmedPrompt;
        vscode.window.showInformationMessage(
          `AI Prompt Logged: "${preview}"`
        );
      }

      return newEntry;
    });
  }

  /**
   * Delete a single entry by ID
   */
  public async deleteEntry(id: string, workspaceFolderUri?: vscode.Uri): Promise<boolean> {
    const targetFolder =
      workspaceFolderUri ||
      (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]?.uri);

    if (!targetFolder) {
      return false;
    }

    return this.lock.runExclusive(async () => {
      const history = await this.readHistory(targetFolder);
      const filtered = history.filter((e) => e.id !== id);

      if (filtered.length === history.length) {
        return false;
      }

      const logUri = this.getLogUri(targetFolder);
      if (!logUri) {
        return false;
      }

      await this.ensureParentDirectory(logUri);
      const jsonString = JSON.stringify(filtered, null, 2) + '\n';
      await vscode.workspace.fs.writeFile(logUri, Buffer.from(jsonString, 'utf8'));
      this._onDidChangeHistory.fire(filtered);
      return true;
    });
  }

  /**
   * Clear all entries from the history log.
   */
  public async clearHistory(workspaceFolderUri?: vscode.Uri): Promise<boolean> {
    const targetFolder =
      workspaceFolderUri ||
      (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]?.uri);

    if (!targetFolder) {
      return false;
    }

    return this.lock.runExclusive(async () => {
      const logUri = this.getLogUri(targetFolder);
      if (!logUri) {
        return false;
      }

      await this.ensureParentDirectory(logUri);
      await vscode.workspace.fs.writeFile(logUri, Buffer.from('[]\n', 'utf8'));
      this._onDidChangeHistory.fire([]);
      return true;
    });
  }

  /**
   * Calculate summary metrics from prompt history.
   */
  public getStats(entries: PromptHistoryEntry[]): PromptStats {
    if (entries.length === 0) {
      return {
        totalCount: 0,
        todayCount: 0,
        topFiles: [],
        topLanguages: [],
        firstLogged: null,
        lastLogged: null,
      };
    }

    const todayStr = new Date().toISOString().substring(0, 10);
    let todayCount = 0;
    const fileMap = new Map<string, number>();
    const langMap = new Map<string, number>();

    entries.forEach((e) => {
      if (e.timestamp && e.timestamp.startsWith(todayStr)) {
        todayCount++;
      }
      const file = e.metadata.activeFilePath || e.metadata.activeFile;
      if (file) {
        fileMap.set(file, (fileMap.get(file) || 0) + 1);
      }
      const lang = e.metadata.languageId;
      if (lang) {
        langMap.set(lang, (langMap.get(lang) || 0) + 1);
      }
    });

    const topFiles = Array.from(fileMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([file, count]) => ({ file, count }));

    const topLanguages = Array.from(langMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([language, count]) => ({ language, count }));

    return {
      totalCount: entries.length,
      todayCount,
      topFiles,
      topLanguages,
      firstLogged: entries[0]?.timestamp || null,
      lastLogged: entries[entries.length - 1]?.timestamp || null,
    };
  }

  public dispose(): void {
    this._onDidChangeHistory.dispose();
  }
}
