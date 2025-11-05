import { Command } from 'commander';
import { handleError } from '@/src/utils';
import { handleLogin } from './actions/login';
import type { LoginOptions } from './types';

// Create command for CLI authentication
export const login = new Command()
  .name('login')
  .description('Authenticate with ElizaOS Cloud to get an API key');

login
  .option(
    '-u, --cloud-url <url>',
    'URL of ElizaOS Cloud',
    process.env.ELIZA_CLOUD_URL || 'https://www.elizacloud.ai'
  )
  .option('--no-browser', 'Do not automatically open browser')
  .option('--timeout <seconds>', 'Authentication timeout in seconds', '300')
  .action(async (options: LoginOptions) => {
    try {
      await handleLogin(options);
    } catch (error) {
      handleError(error);
    }
  });

// Export types and actions for testing
export * from './types';
export * from './actions/login';
