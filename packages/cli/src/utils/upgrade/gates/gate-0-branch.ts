import { GateConfig } from '../types';
import { execa } from 'execa';

export const gate0Branch: GateConfig = {
  name: 'Gate 0: Branch Creation',
  maxTurns: 3,
  prompt: `Create a new git branch called '1.x' for the ElizaOS migration.

Execute these commands:
1. git checkout -b 1.x
2. git branch --show-current

Verify the output shows '1.x' as the current branch.

If the branch already exists, switch to it with 'git checkout 1.x'.`,

  validation: async (context) => {
    try {
      const result = await execa('git', ['branch', '--show-current'], {
        cwd: context.repoPath,
      });
      return result.stdout.trim() === '1.x';
    } catch (error) {
      return false;
    }
  },

  retryStrategy: {
    maxAttempts: 2,
    backoffMs: 1000,
  },
};
