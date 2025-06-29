import { GateConfig } from '../types';
import { execa } from 'execa';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const access = promisify(fs.access);

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export const gate2Setup: GateConfig = {
  name: 'Gate 2: Initial Setup',
  maxTurns: 10,
  requiredGuides: ['migration_guide'],
  systemPrompt:
    'You are migrating an ElizaOS plugin to version 1.x. Follow the migration guide steps precisely.',

  prompt: `Complete initial setup using MIGRATION_GUIDE.md Steps 1-5.

First, read MIGRATION_ANALYSIS.md to understand what needs to be done.

Then:
1. Delete files: biome.json, vitest.config.ts, all *.lock files
2. Update package.json:
   - Fix name if needed (check MIGRATION_ANALYSIS.md)
   - Update all fields as per Step 3 of MIGRATION_GUIDE.md
   - Add agentConfig section
3. Create TypeScript configs:
   - tsconfig.json (Step 4.2)
   - tsconfig.build.json (Step 4.3)  
   - tsup.config.ts (Step 4.1)
4. Run: bun install
5. Run: bun run build

The build MUST pass before completing this gate.`,

  validation: async (context) => {
    // Check required files exist
    const requiredFiles = ['tsconfig.json', 'tsconfig.build.json', 'tsup.config.ts'];

    for (const file of requiredFiles) {
      const filePath = path.join(context.repoPath, file);
      if (!(await pathExists(filePath))) {
        return false;
      }
    }

    // Check deleted files don't exist
    const deletedFiles = ['biome.json', 'vitest.config.ts'];

    for (const file of deletedFiles) {
      const filePath = path.join(context.repoPath, file);
      if (await pathExists(filePath)) {
        return false;
      }
    }

    // Check build passes
    try {
      await execa('bun', ['run', 'build'], { cwd: context.repoPath });
      context.metadata.buildPassing = true;
      return true;
    } catch {
      context.metadata.buildPassing = false;
      return false;
    }
  },

  retryStrategy: {
    maxAttempts: 3,
    backoffMs: 2000,
  },
};
