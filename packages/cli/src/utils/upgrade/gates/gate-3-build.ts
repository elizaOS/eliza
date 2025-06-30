import { GateConfig } from '../types';
import { execa } from 'execa';

export const gate3Build: GateConfig = {
  name: 'Gate 3: Build Must Pass',
  maxTurns: 15,

  prompt: `The build is failing. Fix all build errors to proceed.

Run 'bun run build' and examine the errors carefully.

Common issues to fix:
- Missing dependencies (add to package.json)
- Import path issues (update to new @elizaos/core paths)
- Missing type definitions
- Syntax errors
- Module resolution problems

Fix each error one by one. After each fix, run 'bun run build' again.
Keep working until the build passes completely with no errors.`,

  validation: async (context) => {
    try {
      const result = await execa('bun', ['run', 'build'], {
        cwd: context.repoPath,
        reject: false,
      });

      const success = result.exitCode === 0;
      context.metadata.buildPassing = success;
      return success;
    } catch {
      context.metadata.buildPassing = false;
      return false;
    }
  },

  onMessage: (message, context) => {
    if (message.type === 'assistant') {
      const text = extractTextFromMessage(message);

      // Track fixes being applied
      if (text.includes('Fixed') || text.includes('Updated') || text.includes('Added')) {
        const fileMatch = text.match(/(?:Fixed|Updated|Added).+in\s+(\S+\.ts)/);
        if (fileMatch) {
          context.metadata.filesModified.add(fileMatch[1]);
        }
      }
    }
  },

  retryStrategy: {
    maxAttempts: 3,
    backoffMs: 3000,
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
