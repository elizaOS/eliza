#!/usr/bin/env node
process.env.NODE_OPTIONS = '--no-deprecation';
process.env.NODE_NO_WARNINGS = '1';

import { agent } from '@/src/commands/agent';
import { create } from '@/src/commands/create';
import { dev } from '@/src/commands/dev';
import { env } from '@/src/commands/env';
import { plugins } from '@/src/commands/plugins';
import { publish } from '@/src/commands/publish';
import { setupMonorepo } from '@/src/commands/setup-monorepo';
import { start } from '@/src/commands/start';
import { teeCommand as tee } from '@/src/commands/tee';
import { test } from '@/src/commands/test';
import { update } from '@/src/commands/update';
import { displayBanner } from '@/src/utils';
import { logger } from '@elizaos/core';
import { Command, Option } from 'commander';
import fs from 'node:fs';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

/**
 * Asynchronous function that serves as the main entry point for the application.
 * It loads environment variables, initializes the CLI program, and parses the command line arguments.
 * @returns {Promise<void>}
 */
async function main() {
  // For ESM modules we need to use import.meta.url instead of __dirname
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // Find package.json relative to the current file
  const packageJsonPath = path.resolve(__dirname, '../package.json');

  // Add a simple check in case the path is incorrect
  let version = '0.0.0'; // Fallback version
  if (!fs.existsSync(packageJsonPath)) {
  } else {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    version = packageJson.version;
  }

  const program = new Command()
    .name('elizaos')
    .version(version, '-v, --version', 'output the version number');

  // Add global options but hide them from global help
  // They will still be passed to all commands for backward compatibility
  program.addOption(
    new Option('-r, --remote-url <url>', 'URL of the remote agent runtime').hideHelp()
  );

  // Create a stop command for testing purposes
  const stopCommand = new Command('stop')
    .description('Stop all running ElizaOS agents running locally')
    .action(async () => {
      logger.info('Stopping all ElizaOS agents...');
      // Use pkill to terminate all ElizaOS processes
      try {
        await import('node:child_process').then(({ exec }) => {
          exec('pkill -f "node.*elizaos" || true', (error) => {
            if (error) {
              logger.error(`Error stopping processes: ${error.message}`);
            } else {
              logger.success('Server shutdown complete');
            }
          });
        });
      } catch (error) {
        logger.error(`Failed to stop processes: ${error.message}`);
      }
    });

  program
    .addCommand(create)
    .addCommand(setupMonorepo)
    .addCommand(plugins)
    .addCommand(agent)
    .addCommand(tee)
    .addCommand(start)
    .addCommand(update)
    .addCommand(test)
    .addCommand(env)
    .addCommand(dev)
    .addCommand(publish)
    .addCommand(stopCommand);

  // if no args are passed, display the banner
  if (process.argv.length === 2) {
    await displayBanner();
  }

  await program.parseAsync();
}

main().catch((error) => {
  logger.error('An error occurred:', error);
  process.exit(1);
});
