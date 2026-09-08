import * as vscode from 'vscode';
import * as path from 'path';
import { HistoryStorageService } from '../services/historyStorage.js';
import { exportToMarkdown, exportToCsv } from '../utils/formatter.js';

export class HistoryWebviewPanel {
  public static currentPanel: HistoryWebviewPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _storageService: HistoryStorageService;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(
    extensionUri: vscode.Uri,
    storageService: HistoryStorageService
  ): HistoryWebviewPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (HistoryWebviewPanel.currentPanel) {
      HistoryWebviewPanel.currentPanel._panel.reveal(column);
      HistoryWebviewPanel.currentPanel.refresh();
      return HistoryWebviewPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'aiPromptHistory',
      'AI Prompt History',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
      }
    );

    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'icon.svg');

    HistoryWebviewPanel.currentPanel = new HistoryWebviewPanel(
      panel,
      storageService
    );
    return HistoryWebviewPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    storageService: HistoryStorageService
  ) {
    this._panel = panel;
    this._storageService = storageService;

    // Listen for storage changes
    const historySub = this._storageService.onDidChangeHistory(() => {
      this.refresh();
    });
    this._disposables.push(historySub);

    // Setup initial content
    this._update();

    // Listen for panel closure
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'ready':
            this.refresh();
            break;

          case 'logPrompt':
            if (message.prompt) {
              await this._storageService.logPrompt(message.prompt, {
                source: 'webview',
                metadata: { tags: message.tags || [] },
              });
              vscode.window.showInformationMessage('AI Prompt recorded to history.');
            }
            break;

          case 'deleteEntry':
            if (message.id) {
              await this._storageService.deleteEntry(message.id);
              vscode.window.showInformationMessage('Prompt entry deleted.');
            }
            break;

          case 'clearHistory': {
            const answer = await vscode.window.showWarningMessage(
              'Are you sure you want to clear all AI prompt history for this workspace?',
              { modal: true },
              'Clear All History'
            );
            if (answer === 'Clear All History') {
              await this._storageService.clearHistory();
              vscode.window.showInformationMessage('AI prompt history cleared.');
            }
            break;
          }

          case 'exportHistory':
            await this.handleExport(message.format);
            break;

          case 'copyToClipboard':
            if (message.text) {
              await vscode.env.clipboard.writeText(message.text);
              vscode.window.showInformationMessage('Prompt copied to clipboard!');
            }
            break;

          case 'openFile':
            if (message.filePath) {
              try {
                let fileUri: vscode.Uri | undefined;
                if (path.isAbsolute(message.filePath)) {
                  fileUri = vscode.Uri.file(message.filePath);
                } else {
                  const workspaceFolders = vscode.workspace.workspaceFolders;
                  if (workspaceFolders && workspaceFolders.length > 0) {
                    fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, message.filePath);
                  } else {
                    fileUri = vscode.Uri.file(message.filePath);
                  }
                }
                if (fileUri) {
                  const doc = await vscode.workspace.openTextDocument(fileUri);
                  const editor = await vscode.window.showTextDocument(doc);
                  if (message.line) {
                    const lineNum = Math.max(0, message.line - 1);
                    const pos = new vscode.Position(lineNum, 0);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(
                      new vscode.Range(pos, pos),
                      vscode.TextEditorRevealType.InCenter
                    );
                  }
                }
              } catch (err) {
                vscode.window.showErrorMessage(`Unable to open file: ${message.filePath}`);
              }
            }
            break;

          case 'openLogFile': {
            const uri = this._storageService.getLogUri();
            if (uri) {
              try {
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc);
              } catch {
                vscode.window.showInformationMessage('Log file does not exist yet. Log a prompt first.');
              }
            }
            break;
          }

          case 'refresh':
            this.refresh();
            break;
        }
      },
      null,
      this._disposables
    );
  }

  public async refresh(): Promise<void> {
    const entries = await this._storageService.readHistory();
    const stats = this._storageService.getStats(entries);
    const config = this._storageService.getConfig();
    this._panel.webview.postMessage({
      command: 'updateData',
      entries,
      stats,
      config,
    });
  }

  private async handleExport(format: 'markdown' | 'csv' | 'json'): Promise<void> {
    const entries = await this._storageService.readHistory();
    if (entries.length === 0) {
      vscode.window.showInformationMessage('No prompt history to export.');
      return;
    }

    let content = '';
    let defaultFileName = 'ai-prompt-history';

    if (format === 'markdown') {
      content = exportToMarkdown(entries, vscode.workspace.name);
      defaultFileName += '.md';
    } else if (format === 'csv') {
      content = exportToCsv(entries);
      defaultFileName += '.csv';
    } else {
      content = JSON.stringify(entries, null, 2);
      defaultFileName += '.json';
    }

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultFileName),
      filters: {
        Files: [format === 'markdown' ? 'md' : format],
      },
    });

    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
      vscode.window.showInformationMessage(`Prompt history successfully exported to ${uri.fsPath}`);
    }
  }

  private _update(): void {
    this._panel.title = 'AI Prompt History';
    this._panel.webview.html = this._getHtmlForWebview();
  }

  public dispose(): void {
    HistoryWebviewPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _getHtmlForWebview(): string {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>AI Prompt History</title>
  <style>
    :root {
      --card-bg: var(--vscode-editor-background);
      --card-border: var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      --card-hover: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.05));
      --accent: var(--vscode-button-background, #0078d4);
      --accent-hover: var(--vscode-button-hoverBackground, #026ec1);
      --badge-bg: var(--vscode-badge-background, #4d4d4d);
      --badge-fg: var(--vscode-badge-foreground, #ffffff);
      --text-muted: var(--vscode-descriptionForeground, #888888);
      --font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      --code-font: var(--vscode-editor-font-family, 'Fira Code', 'Courier New', monospace);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 24px;
      line-height: 1.5;
    }

    .container {
      max-width: 1080px;
      margin: 0 auto;
    }

    /* Header Section */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 24px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--card-border);
      flex-wrap: wrap;
      gap: 16px;
    }

    .header-title h1 {
      font-size: 22px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--vscode-foreground);
    }

    .header-title p {
      color: var(--text-muted);
      margin-top: 4px;
      font-size: 13px;
    }

    .btn-group {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    button {
      background-color: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ffffff);
      border: 1px solid var(--card-border);
      padding: 6px 14px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: background-color 0.15s ease, transform 0.1s ease;
    }

    button:hover {
      background-color: var(--vscode-button-secondaryHoverBackground, #45494e);
    }

    button.primary {
      background-color: var(--accent);
      color: #ffffff;
      border: none;
    }

    button.primary:hover {
      background-color: var(--accent-hover);
    }

    button.danger:hover {
      background-color: var(--vscode-errorForeground, #d32f2f);
      color: #ffffff;
    }

    /* Stats Section */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 14px;
      margin-bottom: 24px;
    }

    .stat-card {
      background: var(--vscode-sideBar-background, rgba(255, 255, 255, 0.03));
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 14px 18px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .stat-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      font-weight: 600;
    }

    .stat-value {
      font-size: 24px;
      font-weight: 700;
      color: var(--vscode-foreground);
    }

    .stat-detail {
      font-size: 11px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Quick Log Box */
    .quick-log-card {
      background: var(--vscode-sideBar-background, rgba(255, 255, 255, 0.02));
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 16px;
      margin-bottom: 24px;
    }

    .quick-log-header {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    textarea {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--card-border));
      border-radius: 4px;
      padding: 10px;
      font-family: inherit;
      font-size: 13px;
      resize: vertical;
      min-height: 60px;
      outline: none;
    }

    textarea:focus {
      border-color: var(--vscode-focusBorder);
    }

    .quick-log-footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 8px;
    }

    /* Search & Filter Bar */
    .filter-bar {
      display: flex;
      gap: 12px;
      margin-bottom: 20px;
      flex-wrap: wrap;
      align-items: center;
    }

    .search-input {
      flex: 1;
      min-width: 240px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--card-border));
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 13px;
      outline: none;
    }

    .search-input:focus {
      border-color: var(--vscode-focusBorder);
    }

    .filter-select {
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border, var(--card-border));
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 12px;
      outline: none;
    }

    /* Entries List */
    .entries-container {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .entry-card {
      background: var(--vscode-sideBar-background, rgba(255, 255, 255, 0.03));
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 16px;
      transition: border-color 0.15s ease, transform 0.1s ease;
      position: relative;
    }

    .entry-card:hover {
      border-color: var(--vscode-focusBorder, var(--accent));
    }

    .entry-meta-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      flex-wrap: wrap;
      gap: 8px;
    }

    .meta-badges {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 12px;
      background: var(--badge-bg);
      color: var(--badge-fg);
    }

    .badge.source-chat {
      background: #0284c7;
      color: #ffffff;
    }

    .badge.source-command {
      background: #7c3aed;
      color: #ffffff;
    }

    .badge.source-webview {
      background: #059669;
      color: #ffffff;
    }

    .badge.source-antigravity {
      background: linear-gradient(135deg, #10b981 0%, #3b82f6 100%);
      color: #ffffff;
    }

    .chip {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(128, 128, 128, 0.15);
      color: var(--vscode-foreground);
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
    }

    .chip:hover {
      background: rgba(128, 128, 128, 0.3);
    }

    .timestamp {
      font-size: 11px;
      color: var(--text-muted);
    }

    .prompt-box {
      font-family: var(--code-font);
      font-size: 13px;
      white-space: pre-wrap;
      word-break: break-word;
      background: var(--vscode-editor-background);
      border: 1px solid var(--card-border);
      border-radius: 4px;
      padding: 12px;
      margin-bottom: 10px;
      line-height: 1.45;
    }

    .selection-preview {
      font-family: var(--code-font);
      font-size: 11px;
      background: rgba(0, 0, 0, 0.2);
      border-left: 3px solid var(--accent);
      padding: 8px 10px;
      border-radius: 2px;
      margin-bottom: 10px;
      color: var(--text-muted);
      max-height: 120px;
      overflow-y: auto;
      white-space: pre-wrap;
    }

    .entry-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      align-items: center;
    }

    .btn-sm {
      padding: 4px 10px;
      font-size: 11px;
    }

    .empty-state {
      text-align: center;
      padding: 48px 16px;
      color: var(--text-muted);
    }

    .empty-state h3 {
      font-size: 16px;
      margin-bottom: 6px;
      color: var(--vscode-foreground);
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
      margin-right: 4px;
    }
    .status-dot.active { background: #22c55e; }
    .status-dot.disabled { background: #ef4444; }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <div class="header">
      <div class="header-title">
        <h1>🧠 AI Prompt History Logger</h1>
        <p>Local, privacy-first log of all prompts sent to AI assistants in this workspace</p>
      </div>
      <div class="btn-group">
        <button id="btnOpenLogFile" title="Open .ai/history.json directly in VS Code">
          📄 Open Log File
        </button>
        <button id="btnExportMd" title="Export as clean Markdown">
          📥 Markdown
        </button>
        <button id="btnExportCsv" title="Export as CSV">
          📊 CSV
        </button>
        <button id="btnClear" class="danger" title="Clear all history entries">
          🗑️ Clear All
        </button>
        <button id="btnRefresh" class="primary" title="Reload history">
          🔄 Refresh
        </button>
      </div>
    </div>

    <!-- Statistics Overview Cards -->
    <div class="stats-grid">
      <div class="stat-card">
        <span class="stat-label">Total Prompts</span>
        <span class="stat-value" id="statTotal">0</span>
        <span class="stat-detail" id="statStorageStatus"><span class="status-dot active"></span> Logging Active</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Logged Today</span>
        <span class="stat-value" id="statToday">0</span>
        <span class="stat-detail">Workspace Prompts</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Top Language</span>
        <span class="stat-value" id="statTopLang">-</span>
        <span class="stat-detail" id="statTopLangDetail">Based on active editor</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Top Active File</span>
        <span class="stat-value" style="font-size: 16px; margin-top: 6px;" id="statTopFile">-</span>
        <span class="stat-detail" id="statTopFileDetail">Most prompted file</span>
      </div>
    </div>

    <!-- Quick Log Bar -->
    <div class="quick-log-card">
      <div class="quick-log-header">
        <span>✏️ Quick Log AI Prompt</span>
      </div>
      <textarea id="quickPromptInput" placeholder="Enter prompt to log manually with current editor & git metadata... (Ctrl+Enter to submit)"></textarea>
      <div class="quick-log-footer">
        <button id="btnQuickLog" class="primary">Record Prompt</button>
      </div>
    </div>

    <!-- Filter & Search Controls -->
    <div class="filter-bar">
      <input type="text" id="searchInput" class="search-input" placeholder="🔍 Search prompts, filenames, languages, models, tags...">
      <select id="sourceFilter" class="filter-select">
        <option value="all">All Sources</option>
        <option value="antigravity">Antigravity AI</option>
        <option value="chat-participant">Chat Participant (@history)</option>
        <option value="command">VS Code Command</option>
        <option value="webview">Webview</option>
      </select>
      <select id="dateFilter" class="filter-select">
        <option value="all">All Time</option>
        <option value="today">Today Only</option>
      </select>
    </div>

    <!-- List of Prompt Entries -->
    <div id="entriesContainer" class="entries-container">
      <div class="empty-state">
        <h3>Loading history...</h3>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    let allEntries = [];
    let currentConfig = {};

    // Elements
    const entriesContainer = document.getElementById('entriesContainer');
    const searchInput = document.getElementById('searchInput');
    const sourceFilter = document.getElementById('sourceFilter');
    const dateFilter = document.getElementById('dateFilter');
    const quickPromptInput = document.getElementById('quickPromptInput');
    const btnQuickLog = document.getElementById('btnQuickLog');

    const statTotal = document.getElementById('statTotal');
    const statToday = document.getElementById('statToday');
    const statTopLang = document.getElementById('statTopLang');
    const statTopFile = document.getElementById('statTopFile');

    // Notify extension that webview is ready
    vscode.postMessage({ command: 'ready' });

    // Listen for extension messages
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.command === 'updateData') {
        allEntries = message.entries || [];
        currentConfig = message.config || {};
        updateStats(message.stats);
        renderEntries();
      }
    });

    function updateStats(stats) {
      if (!stats) return;
      statTotal.textContent = stats.totalCount;
      statToday.textContent = stats.todayCount;
      statTopLang.textContent = stats.topLanguages[0]?.language || 'None';
      statTopLangDetail.textContent = stats.topLanguages[0] ? stats.topLanguages[0].count + ' prompts' : 'No languages recorded';
      statTopFile.textContent = stats.topFiles[0]?.file || 'None';
      statTopFileDetail.textContent = stats.topFiles[0] ? stats.topFiles[0].count + ' prompts' : 'No files recorded';
    }

    function renderEntries() {
      const query = searchInput.value.toLowerCase().trim();
      const selectedSource = sourceFilter.value;
      const selectedDate = dateFilter.value;
      const todayStr = new Date().toISOString().substring(0, 10);

      const filtered = allEntries.filter(entry => {
        // Search query
        if (query) {
          const promptMatch = entry.prompt && entry.prompt.toLowerCase().includes(query);
          const fileMatch = entry.metadata.activeFilePath && entry.metadata.activeFilePath.toLowerCase().includes(query);
          const langMatch = entry.metadata.languageId && entry.metadata.languageId.toLowerCase().includes(query);
          const modelMatch = entry.metadata.model && entry.metadata.model.toLowerCase().includes(query);
          const idMatch = entry.id && entry.id.toLowerCase().includes(query);
          if (!promptMatch && !fileMatch && !langMatch && !modelMatch && !idMatch) {
            return false;
          }
        }

        // Source filter
        if (selectedSource !== 'all' && entry.metadata.source !== selectedSource) {
          return false;
        }

        // Date filter
        if (selectedDate === 'today' && (!entry.timestamp || !entry.timestamp.startsWith(todayStr))) {
          return false;
        }

        return true;
      });

      if (filtered.length === 0) {
        entriesContainer.innerHTML = \`
          <div class="empty-state">
            <h3>No prompts match your criteria</h3>
            <p>Prompts logged via Chat (@history), commands, or the input box above will appear here.</p>
          </div>
        \`;
        return;
      }

      // Newest first
      const sorted = [...filtered].reverse();

      entriesContainer.innerHTML = sorted.map((entry, idx) => {
        const num = filtered.length - idx;
        const date = new Date(entry.timestamp);
        const formattedDate = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
        const sourceClass = 'source-' + (entry.metadata.source || 'command');

        let fileChip = '';
        if (entry.metadata.activeFilePath || entry.metadata.activeFile) {
          const path = entry.metadata.activeFilePath || entry.metadata.activeFile;
          const line = entry.metadata.selection ? entry.metadata.selection.startLine : '';
          const lineText = line ? ':' + line : '';
          fileChip = \`<span class="chip" data-action="open-file" data-file="\${escapeHtml(path)}" data-line="\${line || 0}">📁 \${escapeHtml(path)}\${lineText}</span>\`;
        }

        let branchChip = '';
        if (entry.metadata.gitBranch) {
          branchChip = \`<span class="chip">🌿 \${escapeHtml(entry.metadata.gitBranch)}</span>\`;
        }

        let selectionSnippet = '';
        if (entry.metadata.selection && entry.metadata.selection.selectedText) {
          selectionSnippet = \`
            <div class="selection-preview">
              <strong>Code Selection (L\${entry.metadata.selection.startLine}-L\${entry.metadata.selection.endLine}):</strong><br/>
              \${escapeHtml(entry.metadata.selection.selectedText)}
            </div>
          \`;
        }

        return \`
          <div class="entry-card" id="card-\${entry.id}">
            <div class="entry-meta-header">
              <div class="meta-badges">
                <span class="badge \${sourceClass}">\${escapeHtml(entry.metadata.source || 'command')}</span>
                <span class="badge">\${escapeHtml(entry.metadata.model || 'model')}</span>
                \${fileChip}
                \${branchChip}
              </div>
              <span class="timestamp">#\${num} • \${formattedDate}</span>
            </div>

            <div class="prompt-box">\${escapeHtml(entry.prompt)}</div>

            \${selectionSnippet}

            <div class="entry-actions">
              <button class="btn-sm" data-action="copy" data-id="\${entry.id}">📋 Copy Prompt</button>
              <button class="btn-sm danger" data-action="delete" data-id="\${entry.id}">🗑️ Delete</button>
            </div>
          </div>
        \`;
      }).join('');
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    // Event delegation for actions inside entries container
    entriesContainer.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      const id = target.dataset.id;
      if (action === 'delete') {
        vscode.postMessage({ command: 'deleteEntry', id });
      } else if (action === 'copy') {
        const entry = allEntries.find(x => x.id === id);
        if (entry) {
          vscode.postMessage({ command: 'copyToClipboard', text: entry.prompt });
        }
      } else if (action === 'open-file') {
        const filePath = target.dataset.file;
        const line = parseInt(target.dataset.line || '0', 10);
        vscode.postMessage({ command: 'openFile', filePath, line });
      }
    });

    btnQuickLog.addEventListener('click', () => {
      const prompt = quickPromptInput.value.trim();
      if (prompt) {
        vscode.postMessage({ command: 'logPrompt', prompt });
        quickPromptInput.value = '';
      }
    });

    quickPromptInput.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'Enter') {
        btnQuickLog.click();
      }
    });

    searchInput.addEventListener('input', renderEntries);
    sourceFilter.addEventListener('change', renderEntries);
    dateFilter.addEventListener('change', renderEntries);

    document.getElementById('btnRefresh').addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });

    document.getElementById('btnOpenLogFile').addEventListener('click', () => {
      vscode.postMessage({ command: 'openLogFile' });
    });

    document.getElementById('btnExportMd').addEventListener('click', () => {
      vscode.postMessage({ command: 'exportHistory', format: 'markdown' });
    });

    document.getElementById('btnExportCsv').addEventListener('click', () => {
      vscode.postMessage({ command: 'exportHistory', format: 'csv' });
    });

    document.getElementById('btnClear').addEventListener('click', () => {
      vscode.postMessage({ command: 'clearHistory' });
    });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
