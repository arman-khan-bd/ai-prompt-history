/**
 * AI Prompt History Logger - Type Definitions
 */

export interface EditorSelectionRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  selectedText?: string;
}

export interface PromptMetadata {
  /** Basename of the active file when prompt was sent (e.g. 'extension.ts') */
  activeFile?: string;
  /** Relative path of the active file in the workspace (e.g. 'src/extension.ts') */
  activeFilePath?: string;
  /** Language identifier of the active document (e.g. 'typescript') */
  languageId?: string;
  /** Cursor or editor selection range if text was selected */
  selection?: EditorSelectionRange;
  /** Total line count of active file */
  lineCount?: number;
  /** Model name or family (e.g. 'gpt-4o', 'claude-3.5-sonnet', 'copilot') */
  model?: string;
  /** Source/origin of the prompt */
  source?: 'chat-participant' | 'command' | 'webview' | 'api' | 'extension' | 'antigravity';
  /** Name of the current workspace folder */
  workspaceName?: string;
  /** Current Git branch name if inside a Git repository */
  gitBranch?: string;
  /** Subcommand used in chat (e.g. '/log', '/stats') */
  chatCommand?: string;
  /** Custom user tags */
  tags?: string[];
  /** Additional custom key-value pairs */
  [key: string]: unknown;
}

export interface PromptHistoryEntry {
  /** Unique identifier for the prompt entry (UUID) */
  id: string;
  /** ISO 8601 timestamp when the prompt was recorded */
  timestamp: string;
  /** The raw text content of the prompt */
  prompt: string;
  /** Rich contextual metadata at the moment of logging */
  metadata: PromptMetadata;
}

export interface LoggerConfig {
  /** Whether prompt logging is enabled */
  enabled: boolean;
  /** Filename for the local prompt history (default: .ai/history.json) */
  fileName: string;
  /** Whether to automatically add the log file to .gitignore */
  autoGitignore: boolean;
  /** Whether to capture active file, line range, and language metadata */
  captureMetadata: boolean;
  /** Maximum number of prompt entries to retain (0 = unlimited) */
  maxEntries: number;
  /** Show notification in VS Code when a prompt is logged */
  notifyOnLog: boolean;
  /** Automatically capture prompts from Antigravity transcripts */
  antigravityAutoCapture: boolean;
  /** Custom path to Antigravity brain directory (empty for auto-detect) */
  antigravityBrainPath: string;
}

export interface PromptStats {
  totalCount: number;
  todayCount: number;
  topFiles: { file: string; count: number }[];
  topLanguages: { language: string; count: number }[];
  firstLogged: string | null;
  lastLogged: string | null;
}
