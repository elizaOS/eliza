import { handleError } from '@/src/utils';
import { validatePort } from '@/src/utils/port-validation';
import { Command, Option } from 'commander';
import { startDevMode } from './actions/dev-server';
import { DevOptions } from './types';

/**
 * Create a command that runs start in watch mode with auto-restart
 */
export const dev = new Command()
  .name('dev')
  .description(
    'Start the project or plugin in development mode with auto-rebuild, detailed logging, and file change detection'
  )
  .option('-c, --configure', 'Reconfigure services and AI models (skips using saved configuration)')
  .option('--character [paths...]', 'Character file(s) to use - accepts paths or URLs')
  .option('-b, --build', 'Build the project before starting')
  .addOption(
    new Option('-p, --port <port>', 'Port to listen on (default: 3000)').argParser(validatePort)
  )
  .action(async (options: DevOptions) => {
    try {
      await startDevMode(options);
    } catch (error) {
      handleError(error);
    }
  });

// Re-export for backward compatibility
export * from './actions/dev-server';
export * from './types';
export * from './utils/build-utils';
export * from './utils/file-watcher';
export * from './utils/server-manager';
