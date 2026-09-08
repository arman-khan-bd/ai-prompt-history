import * as vscode from 'vscode';
import { HistoryStorageService } from '../services/historyStorage.js';
import { HistoryWebviewPanel } from './historyWebview.js';

export class HistorySidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'aiPromptLogger.historySidebarView';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _storageService: HistoryStorageService
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'resources')],
    };

    // Message handling must be registered BEFORE setting HTML to avoid losing the initial 'ready' message
    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.command) {
        case 'ready':
          this.refresh();
          break;
        case 'refresh':
          this.refresh();
          break;
        case 'openFullDashboard':
          HistoryWebviewPanel.createOrShow(this._extensionUri, this._storageService);
          break;
        case 'copyPrompt':
          if (data.text) {
            await vscode.env.clipboard.writeText(data.text);
            vscode.window.showInformationMessage('Prompt copied to clipboard!');
          }
          break;
        case 'quickLog':
          if (data.prompt) {
            let activeFolderUri: vscode.Uri | undefined;
            if (vscode.window.activeTextEditor) {
              const match = vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
              if (match) {
                activeFolderUri = match.uri;
              }
            }
            await this._storageService.logPrompt(data.prompt, {
              source: 'webview',
              workspaceFolderUri: activeFolderUri,
            });
          }
          break;
        case 'deleteEntry':
          if (data.id) {
            await this._storageService.deleteEntry(data.id);
          }
          break;
      }
    });

    webviewView.webview.html = this._getHtmlForWebview();

    // Refresh on storage changes
    const sub = this._storageService.onDidChangeHistory(() => {
      this.refresh();
    });
    webviewView.onDidDispose(() => sub.dispose());
  }

  public async refresh(): Promise<void> {
    if (this._view) {
      const entries = await this._storageService.readHistory();
      const stats = this._storageService.getStats(entries);
      this._view.webview.postMessage({
        command: 'update',
        entries,
        stats,
      });
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
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 12px);
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background);
      padding: 10px;
      margin: 0;
    }
    .btn-full {
      width: 100%;
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 12px;
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 6px;
    }
    .btn-full:hover {
      background-color: var(--vscode-button-hoverBackground);
    }
    .input-box {
      width: 100%;
      box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.2));
      padding: 6px 8px;
      border-radius: 3px;
      font-size: 11px;
      margin-bottom: 10px;
      outline: none;
    }
    .input-box:focus {
      border-color: var(--vscode-focusBorder);
    }
    .stats-badge {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 10px;
      display: flex;
      justify-content: space-between;
    }
    .item-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .item-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.15));
      border-radius: 4px;
      padding: 8px;
      position: relative;
    }
    .item-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }
    .item-prompt {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.3;
      max-height: 80px;
      overflow-y: hidden;
      text-overflow: ellipsis;
    }
    .item-footer {
      display: flex;
      justify-content: flex-end;
      gap: 4px;
      margin-top: 6px;
    }
    .btn-icon {
      background: none;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      font-size: 10px;
      padding: 2px 4px;
      opacity: 0.8;
    }
    .btn-icon:hover {
      opacity: 1;
      text-decoration: underline;
    }
    .empty-state {
      text-align: center;
      padding: 20px 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
  </style>
</head>
 <body>
  <button id="btnOpenDashboard" class="btn-full">📊 Open Dashboard</button>
  <input type="text" id="searchInput" class="input-box" placeholder="🔍 Search prompts...">
  <select id="sourceFilter" class="input-box">
    <option value="all">All Sources</option>
    <option value="antigravity">Antigravity AI</option>
    <option value="chat-participant">Chat Participant (@history)</option>
    <option value="command">VS Code Command</option>
    <option value="webview">Webview</option>
  </select>
  <div class="stats-badge">
    <span id="statText">Prompts: 0</span>
    <span id="statTodayText">Today: 0</span>
  </div>
  <div id="itemsContainer" class="item-list"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let entries = [];

    vscode.postMessage({ command: 'ready' });

    window.addEventListener('message', (e) => {
      if (e.data.command === 'update') {
        entries = e.data.entries || [];
        const stats = e.data.stats;
        document.getElementById('statText').textContent = 'Total: ' + (stats ? stats.totalCount : 0);
        document.getElementById('statTodayText').textContent = 'Today: ' + (stats ? stats.todayCount : 0);
        render();
      }
    });

    document.getElementById('btnOpenDashboard').addEventListener('click', () => {
      vscode.postMessage({ command: 'openFullDashboard' });
    });

    document.getElementById('searchInput').addEventListener('input', render);
    document.getElementById('sourceFilter').addEventListener('change', render);

    function render() {
      const q = document.getElementById('searchInput').value.toLowerCase().trim();
      const sourceFilter = document.getElementById('sourceFilter');
      const selectedSource = sourceFilter ? sourceFilter.value : 'all';
      const container = document.getElementById('itemsContainer');

      const filtered = entries.filter(e => {
        if (selectedSource !== 'all' && e.metadata.source !== selectedSource) {
          return false;
        }
        if (!q) return true;
        return (e.prompt && e.prompt.toLowerCase().includes(q)) ||
               (e.metadata.activeFile && e.metadata.activeFile.toLowerCase().includes(q));
      });

      if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state">No prompts found</div>';
        return;
      }

      const recent = [...filtered].reverse().slice(0, 50);

      container.innerHTML = recent.map(e => {
        const time = new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const file = e.metadata.activeFile ? ' • ' + escapeHtml(e.metadata.activeFile) : '';
        return \`
          <div class="item-card">
            <div class="item-header">
              <span>\${escapeHtml(e.metadata.source || 'ai')}\${file}</span>
              <span>\${time}</span>
            </div>
            <div class="item-prompt">\${escapeHtml(e.prompt)}</div>
            <div class="item-footer">
              <button class="btn-icon" data-action="copy" data-id="\${escapeHtml(e.id)}">Copy</button>
              <button class="btn-icon" data-action="delete" data-id="\${escapeHtml(e.id)}">Delete</button>
            </div>
          </div>
        \`;
      }).join('');
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    document.getElementById('itemsContainer').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (action === 'delete') {
        vscode.postMessage({ command: 'deleteEntry', id });
      } else if (action === 'copy') {
        const item = entries.find(x => x.id === id);
        if (item) {
          vscode.postMessage({ command: 'copyPrompt', text: item.prompt });
        }
      }
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
