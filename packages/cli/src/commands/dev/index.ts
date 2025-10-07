import { handleError } from '@/src/utils';

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
    new Option('-p, --port <port>', 'Port to listen on (default: 3000)').argParser((value) => {
      const port = Number.parseInt(value, 10);
      if (Number.isNaN(port) || port < 0 || port > 65535) {
        throw new Error('Port must be a number between 0 and 65535');
      }
      return port;
    })
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
