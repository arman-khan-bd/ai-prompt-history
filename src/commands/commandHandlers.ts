import * as vscode from 'vscode';
import { HistoryStorageService } from '../services/historyStorage.js';
import { HistoryWebviewPanel } from '../views/historyWebview.js';
import { exportToMarkdown, exportToCsv } from '../utils/formatter.js';

export function registerCommands(
  context: vscode.ExtensionContext,
  storageService: HistoryStorageService
): void {
  // 1. Open Full History Webview Panel
  context.subscriptions.push(
    vscode.commands.registerCommand('aiPromptLogger.openHistoryWebview', () => {
      HistoryWebviewPanel.createOrShow(context.extensionUri, storageService);
    })
  );

  // 2. Quick Log Prompt via VS Code Input Box
  context.subscriptions.push(
    vscode.commands.registerCommand('aiPromptLogger.logPrompt', async () => {
      const prompt = await vscode.window.showInputBox({
        title: 'AI Prompt Logger: Record Prompt',
        prompt: 'Enter prompt text sent to an AI assistant/agent (active file & selection will be attached)',
        placeHolder: 'e.g. Refactor this function to use async/await and add docstrings...',
        ignoreFocusOut: true,
      });

      if (prompt && prompt.trim()) {
        let activeFolderUri: vscode.Uri | undefined;
        if (vscode.window.activeTextEditor) {
          const match = vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
          if (match) {
            activeFolderUri = match.uri;
          }
        }

        const logged = await storageService.logPrompt(prompt, {
          source: 'command',
          workspaceFolderUri: activeFolderUri,
        });
        if (logged) {
          vscode.window.showInformationMessage(
            `Prompt logged to ${storageService.getConfig().fileName}`
          );
        }
      }
    })
  );

  // 3. Open Log File Directly in Editor
  context.subscriptions.push(
    vscode.commands.registerCommand('aiPromptLogger.openLogFile', async () => {
      let activeFolderUri: vscode.Uri | undefined;
      if (vscode.window.activeTextEditor) {
        const match = vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
        if (match) {
          activeFolderUri = match.uri;
        }
      }

      const uri = storageService.getLogUri(activeFolderUri);
      if (!uri) {
        vscode.window.showWarningMessage('No active workspace folder.');
        return;
      }

      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
      } catch {
        // File doesn't exist yet, offer to create it with initial empty array
        const createNow = await vscode.window.showInformationMessage(
          `Log file ${storageService.getConfig().fileName} does not exist yet. Initialize it now?`,
          'Create File'
        );
        if (createNow === 'Create File') {
          const parentDirUri = vscode.Uri.joinPath(uri, '..');
          try {
            await vscode.workspace.fs.createDirectory(parentDirUri);
          } catch {
            // Ignore
          }
          await vscode.workspace.fs.writeFile(uri, Buffer.from('[]\n', 'utf8'));
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc);
        }
      }
    })
  );

  // 4. Clear Prompt History
  context.subscriptions.push(
    vscode.commands.registerCommand('aiPromptLogger.clearHistory', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to clear all prompt history for this workspace?',
        { modal: true },
        'Clear All History'
      );

      if (confirm === 'Clear All History') {
        let activeFolderUri: vscode.Uri | undefined;
        if (vscode.window.activeTextEditor) {
          const match = vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
          if (match) {
            activeFolderUri = match.uri;
          }
        }
        await storageService.clearHistory(activeFolderUri);
        vscode.window.showInformationMessage('AI Prompt History has been cleared.');
      }
    })
  );

  // 5. Export Prompt History
  context.subscriptions.push(
    vscode.commands.registerCommand('aiPromptLogger.exportHistory', async () => {
      const entries = await storageService.readHistory();
      if (entries.length === 0) {
        vscode.window.showInformationMessage('No prompt history to export.');
        return;
      }

      const formatPick = await vscode.window.showQuickPick(
        [
          { label: 'Markdown (.md)', description: 'Human-readable markdown document with code snippets', value: 'markdown' },
          { label: 'CSV (.csv)', description: 'Spreadsheet compatible comma-separated values', value: 'csv' },
          { label: 'JSON (.json)', description: 'Raw structured JSON array', value: 'json' },
        ],
        { title: 'Select Export Format' }
      );

      if (!formatPick) {
        return;
      }

      let content = '';
      let defaultFileName = 'ai-prompt-history';

      if (formatPick.value === 'markdown') {
        content = exportToMarkdown(entries, vscode.workspace.name);
        defaultFileName += '.md';
      } else if (formatPick.value === 'csv') {
        content = exportToCsv(entries);
        defaultFileName += '.csv';
      } else {
        content = JSON.stringify(entries, null, 2);
        defaultFileName += '.json';
      }

      const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultFileName),
        filters: { Files: [formatPick.value === 'markdown' ? 'md' : formatPick.value] },
      });

      if (saveUri) {
        await vscode.workspace.fs.writeFile(saveUri, Buffer.from(content, 'utf8'));
        const openNow = await vscode.window.showInformationMessage(
          `Export saved to ${saveUri.fsPath}`,
          'Open File'
        );
        if (openNow === 'Open File') {
          const doc = await vscode.workspace.openTextDocument(saveUri);
          await vscode.window.showTextDocument(doc);
        }
      }
    })
  );

  // 6. Refresh History
  context.subscriptions.push(
    vscode.commands.registerCommand('aiPromptLogger.refreshHistory', async () => {
      if (HistoryWebviewPanel.currentPanel) {
        await HistoryWebviewPanel.currentPanel.refresh();
      }
      vscode.window.showInformationMessage('AI Prompt History refreshed.');
    })
  );
}
