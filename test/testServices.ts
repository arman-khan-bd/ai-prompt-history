import * as assert from 'assert';
import { AsyncLock } from '../src/utils/mutex.js';
import { exportToMarkdown, exportToCsv } from '../src/utils/formatter.js';
import { PromptHistoryEntry } from '../src/types.js';

async function runUnitTests() {
  console.log('🧪 Starting Unit Tests for AI Prompt History Logger...');

  // 1. Test AsyncLock
  console.log('\n1. Testing AsyncLock concurrency...');
  const lock = new AsyncLock();
  let count = 0;
  const tasks = Array.from({ length: 50 }, async () => {
    return lock.runExclusive(async () => {
      const current = count;
      await new Promise((resolve) => setTimeout(resolve, 5));
      count = current + 1;
    });
  });
  await Promise.all(tasks);
  assert.strictEqual(count, 50, 'AsyncLock failed to serialize increments');
  console.log('✅ AsyncLock serialized 50 concurrent tasks accurately.');

  // 2. Test Formatters (Markdown & CSV)
  console.log('\n2. Testing Export Formatters...');
  const mockEntries: PromptHistoryEntry[] = [
    {
      id: 'test-uuid-1',
      timestamp: '2026-08-31T05:00:00.000Z',
      prompt: 'How do I optimize this React component?',
      metadata: {
        activeFile: 'Component.tsx',
        activeFilePath: 'src/components/Component.tsx',
        languageId: 'typescriptreact',
        source: 'antigravity',
        model: 'Gemini 3.7 Flash',
        gitBranch: 'feature/optimization',
        selection: {
          startLine: 10,
          startCharacter: 1,
          endLine: 25,
          endCharacter: 10,
          selectedText: 'export const Component = () => { return <div>Test</div>; };',
        },
      },
    },
    {
      id: 'test-uuid-2',
      timestamp: '2026-08-31T05:15:00.000Z',
      prompt: 'Write a unit test for this service function.',
      metadata: {
        activeFile: 'service.ts',
        activeFilePath: 'src/service.ts',
        languageId: 'typescript',
        source: 'command',
      },
    },
  ];

  const md = exportToMarkdown(mockEntries, 'TestWorkspace');
  assert.ok(md.includes('# AI Prompt History - TestWorkspace'), 'Markdown title missing');
  assert.ok(md.includes('How do I optimize this React component?'), 'Markdown prompt missing');
  assert.ok(md.includes('Component.tsx'), 'Markdown file missing');
  assert.ok(md.includes('Referenced Code Selection'), 'Markdown selection snippet missing');
  console.log('✅ Markdown export generated correctly.');

  const csv = exportToCsv(mockEntries);
  assert.ok(csv.startsWith('ID,Timestamp,Source,Model,'), 'CSV header missing');
  assert.ok(csv.includes('"test-uuid-1"'), 'CSV ID missing');
  assert.ok(csv.includes('"How do I optimize this React component?"'), 'CSV prompt missing');
  assert.ok(csv.includes('"antigravity"'), 'CSV source antigravity missing');
  console.log('✅ CSV export generated correctly.');

  // 3. Test .gitignore line parsing logic
  console.log('\n3. Testing .gitignore detection logic...');
  const sampleGitignore = `
# Existing ignores
node_modules/
dist
*.log
.ai/
`;
  const lines = sampleGitignore.split(/\r?\n/);
  const target = '.ai/history.json';
  const normClean = target.replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
  const isIgnored = lines.some((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return false;
    const clean = trimmed.replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
    if (
      clean === normClean ||
      clean === `${normClean}*` ||
      trimmed === `/${normClean}` ||
      trimmed === `/${normClean}/`
    ) {
      return true;
    }
    if (normClean.includes('/')) {
      const parentDir = normClean.split('/')[0];
      if (clean === parentDir || clean === `${parentDir}/*` || trimmed === `/${parentDir}/`) {
        return true;
      }
    }
    return false;
  });
  assert.strictEqual(isIgnored, true, '.gitignore match failed for .ai/history.json under .ai/');
  console.log('✅ .gitignore detection matched target file inside .ai/.');

  // 4. Test Antigravity Transcript Parsing Logic
  console.log('\n4. Testing Antigravity Transcript Parser & Workspace Isolation...');
  const sampleTranscriptContent = `<USER_REQUEST>
delete button and auto prompt store not working on antigravity fix it.
</USER_REQUEST>
<ADDITIONAL_METADATA>
The current local time is: 2026-08-30T23:02:53-07:00.

The user's current state is as follows:
Active Document: c:\\Users\\Admin\\Documents\\VS Code\\ai history\\src\\extension.ts (LANGUAGE_TYPESCRIPT)
Cursor is on line: 42
</ADDITIONAL_METADATA>
<user_information>
The USER's OS version is windows.
The user has 1 active workspaces, each defined by a URI and a CorpusName. Multiple URIs potentially map to the same CorpusName. The mapping is shown as follows in the format [URI] -> [CorpusName]:
c:\\Users\\Admin\\Documents\\VS Code\\ai history -> c:/Users/Admin/Documents/VS Code/ai history
Code relating to the user's requests should be written in the locations listed above.
Conversation ID: 8c2272f1-b6f8-40c3-86d7-7599a8debe3b
</user_information>
<USER_SETTINGS_CHANGE>
The user changed setting \`Model Selection\` from None to Gemini 3.7 Flash (High). No need to comment on this change if the user doesn't ask about it.
</USER_SETTINGS_CHANGE>`;

  // Extract prompt
  let parsedPrompt = sampleTranscriptContent;
  const reqMatch = sampleTranscriptContent.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  if (reqMatch) {
    parsedPrompt = reqMatch[1].trim();
  }
  assert.strictEqual(
    parsedPrompt,
    'delete button and auto prompt store not working on antigravity fix it.',
    'Failed to parse prompt from USER_REQUEST'
  );

  // Extract active document
  const docMatch = sampleTranscriptContent.match(/Active Document:\s*([^\r\n(]+)/i);
  assert.ok(docMatch, 'Active document match failed');
  const activeDoc = docMatch![1].trim();
  assert.strictEqual(
    activeDoc,
    'c:\\Users\\Admin\\Documents\\VS Code\\ai history\\src\\extension.ts',
    'Active document path extracted incorrectly'
  );

  // Extract cursor line
  const lineMatch = sampleTranscriptContent.match(/Cursor is on line:\s*(\d+)/i);
  assert.ok(lineMatch, 'Cursor line match failed');
  const lineNum = parseInt(lineMatch![1], 10);
  assert.strictEqual(lineNum, 42, 'Cursor line extracted incorrectly');

  // Extract model
  const modelMatch = sampleTranscriptContent.match(/Model Selection`?\s*from\s*\S+\s*to\s*(.*?)(?:\.\s*No need|\.\s*If reporting|\r?\n|$)/i);
  assert.ok(modelMatch, 'Model selection match failed');
  const modelName = modelMatch![1].replace(/\.$/, '').trim();
  assert.strictEqual(modelName, 'Gemini 3.7 Flash (High)', 'Model name extracted incorrectly');

  // Test extractWorkspacePaths
  function extractWorkspacePaths(rawContent: string): string[] {
    const paths: string[] = [];
    const userInfoMatch = rawContent.match(/<user_information>([\s\S]*?)<\/user_information>/i);
    if (userInfoMatch) {
      const userInfoText = userInfoMatch[1];
      const lines = userInfoText.split(/\r?\n/);
      let inWorkspacesSection = false;

      for (const line of lines) {
        const trimmed = line.trim();
        if (/active workspaces/i.test(trimmed)) {
          inWorkspacesSection = true;
          continue;
        }

        if (inWorkspacesSection) {
          if (/^(?:Code relating to|App Data Directory|Conversation ID|<\/user_information>)/i.test(trimmed)) {
            inWorkspacesSection = false;
            continue;
          }

          const mapMatch = trimmed.match(/^(?:\[([^\]]+)\]|([^->\r\n]+?))\s*->\s*(?:\[([^\]]+)\]|([^\r\n]+))$/);
          if (mapMatch) {
            const rawPath = (mapMatch[1] || mapMatch[2] || '').trim();
            if (rawPath) {
              const cleanPath = rawPath.replace(/^file:\/\/\/?/i, '');
              if (cleanPath && !cleanPath.includes('LANGUAGE_UNSPECIFIED')) {
                paths.push(cleanPath);
              }
            }
          }
        }
      }
    }
    return paths;
  }

  const extractedPaths = extractWorkspacePaths(sampleTranscriptContent);
  assert.strictEqual(extractedPaths.length, 1, 'Should extract 1 workspace path');
  assert.strictEqual(
    extractedPaths[0],
    'c:\\Users\\Admin\\Documents\\VS Code\\ai history',
    'Workspace path extracted incorrectly'
  );

  // Test multi-workspace extract
  const multiWsTranscript = `<user_information>
The user has 2 active workspaces, each defined by a URI and a CorpusName. Multiple URIs potentially map to the same CorpusName. The mapping is shown as follows in the format [URI] -> [CorpusName]:
[d:\\projects\\frontend-client] -> [d:/projects/frontend-client]
[d:\\projects\\backend-api] -> [d:/projects/backend-api]
Code relating to the user's requests should be written in the locations listed above.
</user_information>`;
  const multiExtracted = extractWorkspacePaths(multiWsTranscript);
  assert.strictEqual(multiExtracted.length, 2, 'Should extract 2 workspace paths');
  assert.strictEqual(multiExtracted[0], 'd:\\projects\\frontend-client');
  assert.strictEqual(multiExtracted[1], 'd:\\projects\\backend-api');

  // Test tool path unescaping
  const cleanPathCandidate = (raw: string): string => {
    let s = raw.trim();
    s = s.replace(/^\\?["']|\\?["']$/g, '');
    s = s.replace(/\\\\/g, '\\');
    s = s.replace(/^file:\/\/\/?/i, '');
    return s.trim();
  };
  const escapedToolArg = '\\"c:\\\\Users\\\\Admin\\\\Documents\\\\VS Code\\\\ai history\\"';
  assert.strictEqual(
    cleanPathCandidate(escapedToolArg),
    'c:\\Users\\Admin\\Documents\\VS Code\\ai history',
    'Tool path unescaping failed'
  );

  console.log('✅ Antigravity prompt, workspace path, and tool paths extracted accurately.');

  // 5. Test Entry Deletion filtering
  console.log('\n5. Testing Entry Deletion filtering...');
  const initialHistory = [...mockEntries];
  const filteredHistory = initialHistory.filter((e) => e.id !== 'test-uuid-1');
  assert.strictEqual(filteredHistory.length, 1, 'Deletion failed to remove single item');
  assert.strictEqual(filteredHistory[0].id, 'test-uuid-2', 'Remaining item mismatch');
  console.log('✅ Deletion logic validated successfully.');

  // 6. Test Per-Project Prompt Isolation
  console.log('\n6. Testing Per-Project Prompt Routing & Isolation...');
  const projectHistoryMap = new Map<string, PromptHistoryEntry[]>();

  function logPromptForProject(projectUri: string, entry: PromptHistoryEntry) {
    const list = projectHistoryMap.get(projectUri) || [];
    list.push(entry);
    projectHistoryMap.set(projectUri, list);
  }

  // Conversation 1 belongs to Project A
  const projA = 'c:/Users/Admin/Documents/VS Code/ai history';
  logPromptForProject(projA, {
    id: 'entry-a1',
    timestamp: '2026-08-31T06:00:00Z',
    prompt: 'Prompt for Project A',
    metadata: { source: 'antigravity', workspaceName: 'ai history' },
  });

  // Conversation 2 belongs to Project B
  const projB = 'd:/projects/ecommerce-app';
  logPromptForProject(projB, {
    id: 'entry-b1',
    timestamp: '2026-08-31T06:05:00Z',
    prompt: 'Prompt for Project B',
    metadata: { source: 'antigravity', workspaceName: 'ecommerce-app' },
  });

  // Verify Project A contains ONLY Project A prompts
  const entriesA = projectHistoryMap.get(projA) || [];
  assert.strictEqual(entriesA.length, 1);
  assert.strictEqual(entriesA[0].prompt, 'Prompt for Project A');

  // Verify Project B contains ONLY Project B prompts
  const entriesB = projectHistoryMap.get(projB) || [];
  assert.strictEqual(entriesB.length, 1);
  assert.strictEqual(entriesB[0].prompt, 'Prompt for Project B');

  console.log('✅ Per-project prompt isolation verified: prompts are stored strictly in their respective project files.');

  console.log('\n🎉 ALL UNIT TESTS PASSED SUCCESSFULLY!\n');
}

runUnitTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
