#!/usr/bin/env node
process.env.NODE_OPTIONS = '--no-deprecation';
process.env.NODE_NO_WARNINGS = '1';

import { agent } from '@/src/commands/agent';
import { create } from '@/src/commands/create';
import { dev } from '@/src/commands/dev';
import { env } from '@/src/commands/env';
import { plugins } from '@/src/commands/plugins';
import { publish } from '@/src/commands/publish';
import { monorepo } from '@/src/commands/monorepo';
import { start } from '@/src/commands/start';
import { teeCommand as tee } from '@/src/commands/tee';
import { test } from '@/src/commands/test';
import { update } from '@/src/commands/update';
import { displayBanner, getVersion, checkAndShowUpdateNotification } from '@/src/utils';
import { logger } from '@elizaos/core';
import { Command } from 'commander';
import { configureEmojis } from '@/src/utils/emoji-handler';

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

/**
 * Asynchronous function that serves as the main entry point for the application.
 * It loads environment variables, initializes the CLI program, and parses the command line arguments.
 * @returns {Promise<void>}
 */
async function main() {
  // Check for --no-emoji flag early (before command parsing)
  if (process.argv.includes('--no-emoji')) {
    configureEmojis({ forceDisable: true });
  }

  // Check for --no-auto-install flag early (before command parsing)
  if (process.argv.includes('--no-auto-install')) {
    process.env.ELIZA_NO_AUTO_INSTALL = 'true';
  }

  // Get version - will return 'monorepo' if in monorepo context
  const version = getVersion();

  // Check for built-in flags that exit early (before preAction hook runs)
  const args = process.argv.slice(2);
  const isUpdateCommand = args.includes('update');
  const willShowBanner = args.length === 0;

  // Show update notification for all commands except:
  // - when banner will show (it handles its own notification)
  // - when running update command
  if (!willShowBanner && !isUpdateCommand) {
    const currentVersion = getVersion();
    await checkAndShowUpdateNotification(currentVersion);
  }

  const program = new Command()
    .name('elizaos')
    .version(version, '-v, --version', 'output the version number')
    .option('--no-emoji', 'Disable emoji output')
    .option('--no-auto-install', 'Disable automatic Bun installation');

  // Add global options but hide them from global help
  // They will still be passed to all commands for backward compatibility
  // Note: Removed --remote-url global option as it conflicts with subcommand options

  program
    .addCommand(create)
    .addCommand(monorepo)
    .addCommand(plugins)
    .addCommand(agent)
    .addCommand(tee)
    .addCommand(start)
    .addCommand(update)
    .addCommand(test)
    .addCommand(env)
    .addCommand(dev)
    .addCommand(publish);

  // if no args are passed, display the banner (it will handle its own update check)
  if (process.argv.length === 2) {
    await displayBanner(false); // Let banner handle update check and show enhanced notification
  }

  await program.parseAsync();
}

main().catch((error) => {
  logger.error('An error occurred:', error);
  process.exit(1);
});
