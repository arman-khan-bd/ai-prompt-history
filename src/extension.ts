import * as vscode from 'vscode';
import { HistoryStorageService } from './services/historyStorage.js';
import { AntigravityWatcherService } from './services/antigravityWatcher.js';
import { registerCommands } from './commands/commandHandlers.js';
import { registerChatParticipant } from './chat/participant.js';
import { HistorySidebarViewProvider } from './views/historySidebar.js';
import { ensureGitignored } from './utils/gitignore.js';

let storageService: HistoryStorageService | undefined;
let antigravityWatcher: AntigravityWatcherService | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('[AI Prompt History Logger] Activating extension...');

  // 1. Initialize Storage Service
  storageService = new HistoryStorageService();
  context.subscriptions.push(storageService);

  // 2. Initialize and Start Antigravity Watcher Service
  antigravityWatcher = new AntigravityWatcherService(storageService);
  context.subscriptions.push(antigravityWatcher);
  antigravityWatcher.start().catch((err) => {
    console.error('[AI Prompt Logger] Failed to start Antigravity watcher:', err);
  });

  // 3. Register Commands
  registerCommands(context, storageService);

  // 4. Register Chat Participant (@history)
  registerChatParticipant(context, storageService);

  // 5. Register Sidebar View Provider
  const sidebarProvider = new HistorySidebarViewProvider(context.extensionUri, storageService);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      HistorySidebarViewProvider.viewType,
      sidebarProvider
    )
  );

  // 6. Setup Status Bar Item
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = 'aiPromptLogger.openHistoryWebview';
  statusBarItem.tooltip = 'Click to open AI Prompt History Dashboard';
  context.subscriptions.push(statusBarItem);

  // Function to update status bar counter
  const updateStatusBar = async () => {
    if (!statusBarItem || !storageService) {
      return;
    }
    const config = storageService.getConfig();
    if (!config.enabled) {
      statusBarItem.text = '$(history) AI Prompts: Off';
      statusBarItem.show();
      return;
    }
    const entries = await storageService.readHistory();
    statusBarItem.text = `$(history) AI Prompts: ${entries.length}`;
    statusBarItem.show();
  };

  context.subscriptions.push(storageService.onDidChangeHistory(() => {
    updateStatusBar();
  }));

  // 7. Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('aiPromptLogger')) {
        await updateStatusBar();
        if (antigravityWatcher) {
          const config = storageService!.getConfig();
          if (config.enabled && config.antigravityAutoCapture) {
            antigravityWatcher.start().catch(console.error);
          } else {
            antigravityWatcher.stop();
          }
        }
      }
    })
  );

  // 8. Initial .gitignore verification & Status Bar update
  const config = storageService.getConfig();
  if (config.enabled && config.autoGitignore) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      ensureGitignored(workspaceFolders[0].uri, config.fileName).catch((err) => {
        console.warn('[AI Prompt Logger] Failed to ensure .gitignore on startup:', err);
      });
    }
  }

  await updateStatusBar();
  console.log('[AI Prompt History Logger] Activated successfully with Antigravity support.');
}

export function deactivate(): void {
  if (antigravityWatcher) {
    antigravityWatcher.dispose();
  }
  if (storageService) {
    storageService.dispose();
  }
}
