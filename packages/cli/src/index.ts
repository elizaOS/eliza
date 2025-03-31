#!/usr/bin/env node
process.env.NODE_OPTIONS = '--no-deprecation';
process.env.NODE_NO_WARNINGS = '1';

import fs from 'node:fs';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '@elizaos/core';
import { Command } from 'commander';
import { agent } from './commands/agent';
import { create } from './commands/create';
import { dev } from './commands/dev';
import { env } from './commands/env';
import { plugin } from './commands/plugin';
import { project } from './commands/project';
import { publish } from './commands/publish';
import { start } from './commands/start';
import { teeCommand as tee } from './commands/tee';
import { test } from './commands/test';
import { update } from './commands/update';
import { loadEnvironment } from './utils/get-config';
import { displayBanner } from './displayBanner';
import { setupMonorepo } from './commands/install';
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

/**
 * Asynchronous function that serves as the main entry point for the application.
 * It loads environment variables, initializes the CLI program, and parses the command line arguments.
 * @returns {Promise<void>}
 */
async function main() {
  // Load environment variables, trying project .env first, then global ~/.eliza/.env
  await loadEnvironment();

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

  const program = new Command().name('elizaos').version(version);

  // Create a stop command for testing purposes
  const stopCommand = new Command('stop')
    .description('Stop all running ElizaOS agents')
    .action(async () => {
      logger.info('Stopping all ElizaOS agents...');
      // Use pkill to terminate all ElizaOS processes
      try {
        await import('child_process').then(({ exec }) => {
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
    .addCommand(project)
    .addCommand(setupMonorepo)
    .addCommand(plugin)
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
    displayBanner();
  }

  await program.parseAsync();
}

main().catch((error) => {
  logger.error('An error occurred:', error);
  process.exit(1);
});
