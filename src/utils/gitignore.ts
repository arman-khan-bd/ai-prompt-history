import * as vscode from 'vscode';
import { AsyncLock } from './mutex.js';

const gitignoreLock = new AsyncLock();

/**
 * Ensures that the specified file is listed in the workspace root's .gitignore file.
 * Creates .gitignore if it does not exist, or appends the entry if not already present.
 *
 * @param workspaceFolderUri The root URI of the workspace folder.
 * @param targetFileName The filename to ignore (e.g. '.prompt-history.json').
 * @returns true if .gitignore was created or modified, false if already present or skipped.
 */
export async function ensureGitignored(
  workspaceFolderUri: vscode.Uri,
  targetFileName: string
): Promise<boolean> {
  return gitignoreLock.runExclusive(async () => {
    try {
      const gitignoreUri = vscode.Uri.joinPath(workspaceFolderUri, '.gitignore');
      const normalizedTarget = targetFileName.trim().replace(/^[/\\]+/, '');

      let exists = false;
      let existingContent = '';

      try {
        const fileData = await vscode.workspace.fs.readFile(gitignoreUri);
        existingContent = Buffer.from(fileData).toString('utf8');
        exists = true;
      } catch (err: unknown) {
        if (
          err instanceof vscode.FileSystemError &&
          (err.code === 'FileNotFound' || err.code === 'EntryNotFound')
        ) {
          exists = false;
        } else if ((err as { code?: string })?.code === 'FileNotFound') {
          exists = false;
        } else {
          // File might not exist yet
          exists = false;
        }
      }

      if (!exists) {
        // Create new .gitignore
        const header = '# AI Prompt History Logger\n';
        const newFileContent = `${header}${normalizedTarget}\n`;
        await vscode.workspace.fs.writeFile(
          gitignoreUri,
          Buffer.from(newFileContent, 'utf8')
        );
        return true;
      }

      // Check if already ignored
      const lines = existingContent.split(/\r?\n/);
      const isAlreadyIgnored = lines.some((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          return false;
        }
        // Match exact name, leading slash, trailing slash, or wildcard patterns
        const clean = trimmed.replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
        const normClean = normalizedTarget.replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
        if (
          clean === normClean ||
          clean === `${normClean}*` ||
          trimmed === `/${normClean}` ||
          trimmed === `/${normClean}/`
        ) {
          return true;
        }
        // If target is inside a directory (e.g. .ai/history.json), check if parent dir is ignored
        if (normClean.includes('/')) {
          const parentDir = normClean.split('/')[0];
          if (clean === parentDir || clean === `${parentDir}/*` || trimmed === `/${parentDir}/`) {
            return true;
          }
        }
        return false;
      });

      if (isAlreadyIgnored) {
        return false;
      }

      // Append entry cleanly
      const hasTrailingNewline =
        existingContent.endsWith('\n') || existingContent.endsWith('\r');
      const prefix = hasTrailingNewline ? '' : '\n';
      const section = `${prefix}\n# AI Prompt History Logger\n${normalizedTarget}\n`;
      const updatedContent = existingContent + section;

      await vscode.workspace.fs.writeFile(
        gitignoreUri,
        Buffer.from(updatedContent, 'utf8')
      );
      return true;
    } catch (error) {
      console.error('[AI Prompt Logger] Failed to update .gitignore:', error);
      return false;
    }
  });
}
