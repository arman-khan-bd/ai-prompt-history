import { PromptHistoryEntry } from '../types.js';

/**
 * Format prompt entries into a clean Markdown document.
 */
export function exportToMarkdown(
  entries: PromptHistoryEntry[],
  workspaceName?: string
): string {
  const title = workspaceName
    ? `# AI Prompt History - ${workspaceName}`
    : '# AI Prompt History';
  const generatedAt = new Date().toISOString();

  let markdown = `${title}\n\n*Generated on: ${generatedAt}* | *Total Prompts: ${entries.length}*\n\n---\n\n`;

  if (entries.length === 0) {
    markdown += '_No prompt entries found._\n';
    return markdown;
  }

  // Iterate newest first
  const sorted = [...entries].reverse();

  sorted.forEach((entry, index) => {
    const num = entries.length - index;
    const dateFormatted = new Date(entry.timestamp).toLocaleString();
    const meta = entry.metadata;

    markdown += `### #${num} - ${dateFormatted}\n\n`;
    markdown += `**ID:** \`${entry.id}\`  \n`;
    markdown += `**Source:** \`${meta.source || 'unknown'}\` | **Model:** \`${meta.model || 'n/a'}\`  \n`;

    if (meta.activeFile) {
      markdown += `**File:** \`${meta.activeFilePath || meta.activeFile}\` (${meta.languageId || 'text'})  \n`;
    }
    if (meta.selection) {
      markdown += `**Selection:** Lines ${meta.selection.startLine}:${meta.selection.startCharacter} - ${meta.selection.endLine}:${meta.selection.endCharacter}  \n`;
    }
    if (meta.gitBranch) {
      markdown += `**Git Branch:** \`${meta.gitBranch}\`  \n`;
    }

    markdown += `\n#### Prompt:\n\n\`\`\`text\n${entry.prompt.trim()}\n\`\`\`\n\n`;

    if (meta.selection?.selectedText) {
      markdown += `<details>\n<summary>Referenced Code Selection</summary>\n\n\`\`\`${meta.languageId || ''}\n${meta.selection.selectedText}\n\`\`\`\n\n</details>\n\n`;
    }

    markdown += `---\n\n`;
  });

  return markdown;
}

/**
 * Format prompt entries into RFC 4180 compliant CSV.
 */
export function exportToCsv(entries: PromptHistoryEntry[]): string {
  const headers = [
    'ID',
    'Timestamp',
    'Source',
    'Model',
    'Active File',
    'Language',
    'Selection Lines',
    'Git Branch',
    'Prompt',
  ];

  const escapeCsv = (val: unknown): string => {
    if (val === undefined || val === null) {
      return '""';
    }
    const str = String(val);
    const escaped = str.replace(/"/g, '""');
    return `"${escaped}"`;
  };

  const rows = entries.map((e) => {
    const selLines = e.metadata.selection
      ? `L${e.metadata.selection.startLine}-L${e.metadata.selection.endLine}`
      : '';
    return [
      escapeCsv(e.id),
      escapeCsv(e.timestamp),
      escapeCsv(e.metadata.source || ''),
      escapeCsv(e.metadata.model || ''),
      escapeCsv(e.metadata.activeFilePath || e.metadata.activeFile || ''),
      escapeCsv(e.metadata.languageId || ''),
      escapeCsv(selLines),
      escapeCsv(e.metadata.gitBranch || ''),
      escapeCsv(e.prompt),
    ].join(',');
  });

  return [headers.join(','), ...rows].join('\r\n');
}
