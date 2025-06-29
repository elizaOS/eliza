import { GateConfig } from '../types';
import { execa } from 'execa';

export const gate5Migration: GateConfig = {
  name: 'Gate 5: Code Migration',
  maxTurns: 25,
  requiredGuides: ['migration_guide', 'advanced_migration_guide', 'prompt_and_generation_guide'],
  systemPrompt:
    'You are an expert at migrating ElizaOS plugins. Use the migration guides to fix code systematically.',

  prompt: `Migrate all code based on MIGRATION_ANALYSIS.md.

For EACH file identified in the analysis:

ACTIONS (Use MIGRATION_GUIDE.md Step 6):
1. Update imports (Step 6.1)
2. Fix state handling (Step 6.2)
3. Replace composeContext (Step 6.3)
4. Convert templates to XML (Step 6.4)
5. Replace generateObject (Step 6.5)
6. Update handler pattern (Step 6.7)

PROVIDERS (Use MIGRATION_GUIDE.md Step 7):
1. Add 'name' property (Step 7.3)
2. Update return type (Step 7.3)
3. Make state non-optional (Step 7.3)

SERVICES (Use ADVANCED_MIGRATION_GUIDE.md):
- Extend base Service class
- Add lifecycle methods

EVALUATORS (Use ADVANCED_MIGRATION_GUIDE.md):
- Update evaluate method signature
- Fix return types

Work file by file. After modifying each file:
1. Run 'bun run build' to check it compiles
2. If build fails, fix immediately before moving to next file
3. Track your progress - don't skip any files!

List each file as you work on it.`,

  validation: async (context) => {
    // Both build and TypeScript must pass
    try {
      await execa('bun', ['run', 'build'], { cwd: context.repoPath });
      await execa('bunx', ['tsc', '--noEmit'], { cwd: context.repoPath });
      context.metadata.buildPassing = true;
      context.metadata.typeCheckPassing = true;
      return true;
    } catch {
      return false;
    }
  },

  onMessage: (message, context) => {
    if (message.type === 'assistant') {
      const text = extractTextFromMessage(message);

      // Track file modifications
      const filePatterns = [
        /(?:Updating|Migrating|Fixed|Working on)\s+(\S+\.ts)/g,
        /File:\s+(\S+\.ts)/g,
        /Modified\s+(\S+\.ts)/g,
      ];

      for (const pattern of filePatterns) {
        const matches = text.matchAll(pattern);
        for (const match of matches) {
          context.metadata.filesModified.add(match[1]);
        }
      }
    }
  },

  retryStrategy: {
    maxAttempts: 2,
    backoffMs: 5000,
  },
};

function extractTextFromMessage(message: any): string {
  if (message.type === 'assistant' && message.message.content) {
    return message.message.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => ('text' in block ? block.text : ''))
      .join('');
  }
  return '';
}
