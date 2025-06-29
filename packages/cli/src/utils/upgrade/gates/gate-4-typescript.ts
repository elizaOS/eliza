import { GateConfig } from '../types';
import { execa } from 'execa';

export const gate4TypeScript: GateConfig = {
  name: 'Gate 4: TypeScript Must Pass',
  maxTurns: 10,
  requiredGuides: ['advanced_migration_guide', 'state_and_providers_guide'],

  prompt: `Fix all TypeScript errors in the project.

Run 'bunx tsc --noEmit' to check for TypeScript errors.

Reference the migration guides for help with:
- State type issues: Check STATE_AND_PROVIDERS_GUIDE.md
- Action types: Check MIGRATION_GUIDE.md Step 6
- Provider types: Check MIGRATION_GUIDE.md Step 7
- Service types: Check ADVANCED_MIGRATION_GUIDE.md

Common type issues:
- Account → Entity
- userId → entityId  
- room → world
- IAgentRuntime import from @elizaos/core
- Missing type imports

Fix each error systematically. Run 'bunx tsc --noEmit' after each fix.
Continue until there are ZERO TypeScript errors.`,

  validation: async (context) => {
    try {
      await execa('bunx', ['tsc', '--noEmit'], {
        cwd: context.repoPath,
      });
      context.metadata.typeCheckPassing = true;
      return true;
    } catch {
      context.metadata.typeCheckPassing = false;
      return false;
    }
  },

  retryStrategy: {
    maxAttempts: 3,
    backoffMs: 2000,
  },
};
