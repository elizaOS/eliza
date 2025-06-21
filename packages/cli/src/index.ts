#!/usr/bin/env node
process.env.NODE_OPTIONS = '--no-deprecation';
process.env.NODE_NO_WARNINGS = '1';

import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
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
  // Check for --no-emoji flag early (before command parsing)
  if (process.argv.includes('--no-emoji')) {
    const { configureEmojis } = await import('./utils/emoji-handler.js');
    configureEmojis({ forceDisable: true });
  }

  // Check for --no-auto-install flag early (before command parsing)
  if (process.argv.includes('--no-auto-install')) {
    process.env.ELIZA_NO_AUTO_INSTALL = 'true';
  }

  // For ESM modules we need to use import.meta.url instead of __dirname
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // Find package.json relative to the current file
  const packageJsonPath = path.resolve(__dirname, '../package.json');

  // Add a simple check in case the path is incorrect
  let version = '0.0.0'; // Fallback version
  if (!existsSync(packageJsonPath)) {
  } else {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    version = packageJson.version;
  }

  // Check for built-in flags that exit early (before preAction hook runs)
  const args = process.argv.slice(2);
  const isUpdateCommand = args.includes('update');
  const willShowBanner = args.length === 0;

  // Show update notification for all commands except:
  // - when banner will show (it handles its own notification)
  // - when running update command
  if (!willShowBanner && !isUpdateCommand) {
    const { getVersion, checkAndShowUpdateNotification } = await import('./utils/index.js');
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

  // Add commands dynamically to avoid static imports that trigger schema loading
  const commands = [
    { name: 'create', path: './commands/create/index.js' },
    { name: 'plugins', path: './commands/plugins/index.js' },
    { name: 'agent', path: './commands/agent/index.js' },
    { name: 'start', path: './commands/start/index.js' },
    { name: 'update', path: './commands/update/index.js' },
    { name: 'test', path: './commands/test/index.js' },
    { name: 'scenario', path: './commands/scenario/index.js' },
    { name: 'test-production-verification', path: './commands/test-production-verification.js' },
    { name: 'stress-test-verification', path: './commands/stress-test-verification.js' },
    { name: 'env', path: './commands/env/index.js' },
    { name: 'publish', path: './commands/publish.js' },
  ];

  // For scenario command specifically, set database type early
  const isScenarioCommand = process.argv.includes('scenario');
  if (isScenarioCommand) {
    console.log('🔧 CLI: Detected scenario command, setting database type to PGLite...');
    try {
      const sqlModule = await import('@elizaos/plugin-sql');
      if ('setDatabaseType' in sqlModule && typeof sqlModule.setDatabaseType === 'function') {
        sqlModule.setDatabaseType('pglite');
        console.log('✅ CLI: Set database type to PGLite for scenario testing');
      } else {
        console.warn('⚠️  CLI: setDatabaseType not found in plugin-sql exports:', Object.keys(sqlModule));
      }
    } catch (error) {
      console.warn('⚠️  CLI: Failed to set database type for scenario:', error);
    }
  }

  for (const cmd of commands) {
    try {
      const commandModule = await import(cmd.path);
      const command = commandModule.default || commandModule[cmd.name] || commandModule[`${cmd.name}Command`];
      if (command) {
        program.addCommand(command);
      }
    } catch (error) {
      console.warn(`Failed to load command ${cmd.name}:`, error);
    }
  }

  // if no args are passed, display the banner (it will handle its own update check)
  if (process.argv.length === 2) {
    const { displayBanner } = await import('./utils/index.js');
    await displayBanner(false); // Let banner handle update check and show enhanced notification
  }

  await program.parseAsync();
}

main().catch((error) => {
  console.error('An error occurred:', error);
  process.exit(1);
});
