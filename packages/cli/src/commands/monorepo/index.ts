import { handleError, withCleanupOnInterrupt } from '@/src/utils';
import { Command } from 'commander';
import { cloneMonorepo } from './actions/clone';
import { CloneInfo, MonorepoOptions } from './types';
import { displayNextSteps } from './utils/setup-instructions';
import { validateMonorepoOptions } from './utils/validation';
import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

/**
 * Create the monorepo command that clones ElizaOS from a specific branch
 */
export const monorepo = new Command()
  .name('monorepo')
  .description('Clone ElizaOS monorepo from a specific branch, defaults to develop')
  .option('-b, --branch <branch>', 'Branch to install', 'develop')
  .option('-d, --dir <directory>', 'Destination directory', './eliza')
  .action(async (opts: Partial<MonorepoOptions>) => {
    try {
      // Validate options
      const options = validateMonorepoOptions(opts);
      
      const repo = 'elizaOS/eliza';
      const branch = options.branch!; // We know this has a value after validation
      const dir = options.dir!; // We know this has a value after validation

      // Get the absolute path for the directory
      const destinationDir = path.resolve(process.cwd(), dir);

      // Check if directory exists and is not empty (do this before cleanup wrapper)
      if (existsSync(destinationDir)) {
        const files = readdirSync(destinationDir);
        if (files.length > 0) {
          const error = new Error(`Destination directory ${destinationDir} already exists and is not empty`);
          error.name = 'ValidationError';
          throw error;
        }
      }

      // Clone the repository with cleanup on interrupt
      await withCleanupOnInterrupt(destinationDir, 'monorepo', async () => {
        // Create clone information with the absolute path
        const cloneInfo: CloneInfo = {
          repo,
          branch,
          destination: destinationDir,
        };
        
        await cloneMonorepo(cloneInfo);
      });

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
