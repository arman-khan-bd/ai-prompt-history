import * as vscode from 'vscode';
import { PromptMetadata, EditorSelectionRange } from '../types.js';

/**
 * Extracts rich contextual metadata from the active text editor and workspace.
 */
export async function captureEditorMetadata(options?: {
  source?: PromptMetadata['source'];
  modelName?: string;
  chatCommand?: string;
  tags?: string[];
}): Promise<PromptMetadata> {
  const metadata: PromptMetadata = {
    source: options?.source || 'command',
    model: options?.modelName || 'default',
    chatCommand: options?.chatCommand,
    tags: options?.tags || [],
  };

  // 1. Active Text Editor Info
  const editor = vscode.window.activeTextEditor;
  let activeFolder: vscode.WorkspaceFolder | undefined;

  if (editor && editor.document) {
    const doc = editor.document;
    metadata.languageId = doc.languageId;
    metadata.lineCount = doc.lineCount;

    // Resolve workspace folder for active doc
    activeFolder = vscode.workspace.getWorkspaceFolder(doc.uri);

    // Basename
    const uri = doc.uri;
    const pathParts = uri.fsPath.split(/[/\\]/);
    metadata.activeFile = pathParts[pathParts.length - 1];

    // Relative Workspace Path
    const relativePath = activeFolder
      ? vscode.workspace.asRelativePath(uri, false)
      : pathParts[pathParts.length - 1];
    metadata.activeFilePath = relativePath;

    // Selection range & text
    if (!editor.selection.isEmpty) {
      const sel = editor.selection;
      const selectedRaw = doc.getText(sel);
      // Truncate selected text if too large for metadata preview (max 800 chars)
      const selectedText =
        selectedRaw.length > 800
          ? `${selectedRaw.substring(0, 800)}... [truncated]`
          : selectedRaw;

      const selectionRange: EditorSelectionRange = {
        startLine: sel.start.line + 1,
        startCharacter: sel.start.character + 1,
        endLine: sel.end.line + 1,
        endCharacter: sel.end.character + 1,
        selectedText,
      };
      metadata.selection = selectionRange;
    }
  }

  // Fallback workspace folder
  if (!activeFolder && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    activeFolder = vscode.workspace.workspaceFolders[0];
  }

  if (activeFolder) {
    metadata.workspaceName = activeFolder.name;
  }

  // 2. Git Branch Resolution
  try {
    const gitBranch = await getActiveGitBranch(activeFolder?.uri);
    if (gitBranch) {
      metadata.gitBranch = gitBranch;
    }
  } catch {
    // Non-critical, ignore
  }

  return metadata;
}

/**
 * Attempts to retrieve current Git branch via VS Code Git Extension API or .git/HEAD
 */
async function getActiveGitBranch(targetFolderUri?: vscode.Uri): Promise<string | undefined> {
  const rootUri = targetFolderUri || (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]?.uri);
  if (!rootUri) {
    return undefined;
  }

  try {
    // Attempt 1: VS Code Git Extension API
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (gitExtension) {
      const gitApi = gitExtension.exports.getAPI(1);
      if (gitApi && gitApi.repositories && gitApi.repositories.length > 0) {
        const repo = gitApi.repositories.find((r: { rootUri?: vscode.Uri }) =>
          r.rootUri && r.rootUri.fsPath.toLowerCase() === rootUri.fsPath.toLowerCase()
        ) || gitApi.repositories[0];
        if (repo && repo.state && repo.state.HEAD && repo.state.HEAD.name) {
          return repo.state.HEAD.name;
        }
      }
    }
  } catch {
    // Fall back to reading .git/HEAD
  }

  // Attempt 2: Read .git/HEAD directly
  try {
    const headUri = vscode.Uri.joinPath(rootUri, '.git', 'HEAD');
    const headData = await vscode.workspace.fs.readFile(headUri);
    const headStr = Buffer.from(headData).toString('utf8').trim();
    if (headStr.startsWith('ref: refs/heads/')) {
      return headStr.replace('ref: refs/heads/', '');
    }
    return headStr.substring(0, 7); // Detached HEAD hash
  } catch {
    return undefined;
  }
}
