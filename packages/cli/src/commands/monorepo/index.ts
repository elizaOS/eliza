import { handleError } from '@/src/utils';
import { Command } from 'commander';
import { cloneMonorepo, prepareDestination } from './actions/clone';
import { MonorepoOptions, CloneInfo } from './types';
import { displayNextSteps } from './utils/setup-instructions';

/**
 * Create the monorepo command that clones ElizaOS from a specific branch
 */
export const monorepo = new Command()
  .name('monorepo')
  .description('Clone ElizaOS monorepo from a specific branch, defaults to develop')
  .option('-b, --branch <branch>', 'Branch to install', 'develop')
  .option('-d, --dir <directory>', 'Destination directory', './eliza')
  .action(async (options: MonorepoOptions) => {
    try {
      const repo = 'elizaOS/eliza';
      const branch = options.branch || 'develop';
      const dir = options.dir || './eliza';

      // Prepare destination directory
      const destinationDir = prepareDestination(dir);

      // Create clone information
      const cloneInfo: CloneInfo = {
        repo,
        branch,
        destination: dir,
      };

      // Clone the repository
      await cloneMonorepo(cloneInfo);

      // Display instructions for next steps
      displayNextSteps(destinationDir);
    } catch (error) {
      handleError(error);
    }
  });

// Re-export for backward compatibility
export * from './actions/clone';
export * from './types';
export * from './utils/setup-instructions';
