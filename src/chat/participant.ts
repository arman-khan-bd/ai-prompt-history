import * as vscode from 'vscode';
import { HistoryStorageService } from '../services/historyStorage.js';

/**
 * Registers the VS Code Chat Participant (`@history`) that intercepts,
 * logs prompts sent in chat, and streams AI model responses.
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  storageService: HistoryStorageService
): vscode.Disposable {
  if (!('chat' in vscode) || typeof vscode.chat?.createChatParticipant !== 'function') {
    console.log('[AI Prompt Logger] Chat Participant API is not supported in this VS Code version.');
    return { dispose: () => {} };
  }

  const participant = vscode.chat.createChatParticipant(
    'ai-prompt-logger.participant',
    async (
      request: vscode.ChatRequest,
      chatContext: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      token: vscode.CancellationToken
    ) => {
      const userPrompt = request.prompt.trim();
      const command = request.command;

      // Handle Subcommands
      if (command === 'stats') {
        const history = await storageService.readHistory();
        const stats = storageService.getStats(history);
        stream.markdown(`### 📊 AI Prompt History Statistics\n\n`);
        stream.markdown(`- **Total Prompts Logged:** \`${stats.totalCount}\`\n`);
        stream.markdown(`- **Prompts Logged Today:** \`${stats.todayCount}\`\n`);
        if (stats.topLanguages.length > 0) {
          stream.markdown(`- **Top Languages:** ${stats.topLanguages.map((l) => `\`${l.language}\` (${l.count})`).join(', ')}\n`);
        }
        if (stats.topFiles.length > 0) {
          stream.markdown(`- **Top Active Files:**\n`);
          stats.topFiles.forEach((f) => {
            stream.markdown(`  - \`${f.file}\` (${f.count})\n`);
          });
        }
        return { metadata: { command: 'stats' } };
      }

      if (command === 'history') {
        const history = await storageService.readHistory();
        if (history.length === 0) {
          stream.markdown(`_No prompts recorded yet in this workspace._\n`);
          return { metadata: { command: 'history' } };
        }

        const recent = history.slice(-5).reverse();
        stream.markdown(`### 🕒 Recent Prompt History (Last 5)\n\n`);
        recent.forEach((item, idx) => {
          const date = new Date(item.timestamp).toLocaleTimeString();
          const fileInfo = item.metadata.activeFile ? ` *(${item.metadata.activeFile})*` : '';
          stream.markdown(`**${idx + 1}. [${date}]**${fileInfo}\n> ${item.prompt}\n\n`);
        });
        stream.markdown(`\n*Tip: Run \`AI Prompt Logger: Open Prompt History Dashboard\` to view all entries.*`);
        return { metadata: { command: 'history' } };
      }

      // Detect available Language Models
      let selectedModel: vscode.LanguageModelChat | undefined;
      try {
        if ('lm' in vscode && typeof vscode.lm?.selectChatModels === 'function') {
          const models = await vscode.lm.selectChatModels({
            vendor: 'copilot',
          });
          if (models.length > 0) {
            selectedModel = models[0];
          } else {
            // Try selecting any available model
            const anyModels = await vscode.lm.selectChatModels();
            if (anyModels.length > 0) {
              selectedModel = anyModels[0];
            }
          }
        }
      } catch (err) {
        console.warn('[AI Prompt Logger] Unable to query Language Models:', err);
      }

      const modelName = selectedModel ? `${selectedModel.vendor}/${selectedModel.family || selectedModel.name}` : 'default-chat';

      let activeFolderUri: vscode.Uri | undefined;
      if (vscode.window.activeTextEditor) {
        const match = vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
        if (match) {
          activeFolderUri = match.uri;
        }
      }

      // 1. Intercept and Log Prompt into .prompt-history.json
      const loggedEntry = await storageService.logPrompt(userPrompt, {
        source: 'chat-participant',
        modelName,
        chatCommand: command,
        workspaceFolderUri: activeFolderUri,
      });

      if (command === 'log') {
        stream.markdown(`✅ **Prompt logged successfully!**\n\n`);
        if (loggedEntry) {
          stream.markdown(`- **ID:** \`${loggedEntry.id}\`\n`);
          stream.markdown(`- **Timestamp:** \`${loggedEntry.timestamp}\`\n`);
          if (loggedEntry.metadata.activeFile) {
            stream.markdown(`- **File Context:** \`${loggedEntry.metadata.activeFilePath || loggedEntry.metadata.activeFile}\`\n`);
          }
          if (loggedEntry.metadata.gitBranch) {
            stream.markdown(`- **Git Branch:** \`${loggedEntry.metadata.gitBranch}\`\n`);
          }
        }
        return { metadata: { command: 'log' } };
      }

      // 2. Forward to Language Model if available
      if (selectedModel) {
        try {
          // Construct chat messages including past turns if available
          const messages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(
              'You are a helpful coding assistant. Answer the user prompt directly and accurately.'
            ),
          ];

          // Append past context turns
          if (chatContext.history) {
            for (const pastTurn of chatContext.history) {
              if (pastTurn instanceof vscode.ChatRequestTurn) {
                messages.push(vscode.LanguageModelChatMessage.User(pastTurn.prompt));
              } else if (pastTurn instanceof vscode.ChatResponseTurn) {
                let responseText = '';
                for (const part of pastTurn.response) {
                  if (part instanceof vscode.ChatResponseMarkdownPart) {
                    responseText += part.value.value;
                  }
                }
                if (responseText) {
                  messages.push(vscode.LanguageModelChatMessage.Assistant(responseText));
                }
              }
            }
          }

          messages.push(vscode.LanguageModelChatMessage.User(userPrompt));

          const response = await selectedModel.sendRequest(messages, {}, token);

          for await (const chunk of response.text) {
            if (token.isCancellationRequested) {
              break;
            }
            stream.markdown(chunk);
          }

          return { metadata: { model: modelName, loggedId: loggedEntry?.id } };
        } catch (err: unknown) {
          console.error('[AI Prompt Logger] Error querying Language Model:', err);
          stream.markdown(`\n\n*(Prompt logged to history file. Note: AI model request failed: ${String(err)})*`);
          return { metadata: { error: String(err) } };
        }
      } else {
        // Fallback when no language model provider is active
        stream.markdown(`📝 **Prompt intercepted & logged into \`${storageService.getConfig().fileName}\`**\n\n`);
        stream.markdown(`> "${userPrompt}"\n\n`);
        if (loggedEntry?.metadata?.activeFile) {
          stream.markdown(`- **Context File:** \`${loggedEntry.metadata.activeFilePath || loggedEntry.metadata.activeFile}\`\n`);
        }
        if (loggedEntry?.metadata?.selection) {
          stream.markdown(`- **Selection:** Lines \`${loggedEntry.metadata.selection.startLine}-${loggedEntry.metadata.selection.endLine}\`\n`);
        }
        stream.markdown(`\n*Log file was checked against \`.gitignore\` to ensure privacy.*`);
        return { metadata: { loggedId: loggedEntry?.id } };
      }
    }
  );

  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.svg');

  context.subscriptions.push(participant);
  return participant;
}
