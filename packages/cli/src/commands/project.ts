import { handleError } from '@/src/utils/handle-error';
import { installPlugin } from '@/src/utils/install-plugin';
import {
  getLocalRegistryIndex,
  getPluginRepository,
  getRegistryIndex,
  normalizePluginName,
} from '@/src/utils/registry/index';
import { logger } from '@elizaos/core';
import { Command } from 'commander';
import { execa } from 'execa';
import path from 'path';
import fs from 'fs';

export const project = new Command().name('project').description('Manage an ElizaOS project');

project
  .command('list-plugins')
  .description('List available plugins to install into the project')
  .option('-t, --type <type>', 'filter by type (adapter, client, plugin)')
  .action(async (opts) => {
    try {
      // Temporarily return hardcoded plugins as an array
      const hardcodedPlugins = [
        '@elizaos/plugin-sql',
        '@elizaos/plugin-twitter',
        '@elizaos/plugin-telegram',
        '@elizaos/plugin-discord',
        '@elizaos/plugin-farcaster',
        '@elizaos/plugin-redpill',
        '@elizaos/plugin-groq',
        '@elizaos/plugin-local-ai',
        '@elizaos/plugin-anthropic',
        '@elizaos/plugin-openai',
        '@elizaos/plugin-solana',
        '@elizaos/plugin-evm',
        '@elizaos/plugin-pdf',
        '@elizaos/plugin-browser',
        '@elizaos/plugin-s3-storage',
        '@elizaos/plugin-video-understanding',
        '@elizaos/plugin-venice',
      ];

      const plugins = hardcodedPlugins
        .filter((name) => !opts.type || name.includes(opts.type))
        .sort();

      logger.info('\nAvailable plugins:');
      for (const plugin of plugins) {
        logger.info(`  ${plugin}`);
      }
      logger.info('');
    } catch (error) {
      handleError(error);
    }
  });

project
  .command('add-plugin')
  .description('Add a plugin to the project')
  .argument('<plugin>', 'plugin name (e.g., "abc", "plugin-abc", "elizaos/plugin-abc")')
  .option('-n, --no-env-prompt', 'Skip prompting for environment variables')
  .action(async (plugin, opts) => {
    try {
      const cwd = process.cwd();

      // Check if we're running under npx
      const isNpx =
        process.env.npm_lifecycle_event === 'npx' ||
        process.env.npm_execpath?.includes('npx') ||
        process.argv[0]?.includes('npx') ||
        process.env.npm_config_user_agent?.includes('npm') ||
        process.env._?.includes('npx') ||
        !!process.env.npm_command;

      // If running under npx, provide clear instructions instead
      if (isNpx) {
        // Extract and normalize the plugin name
        let baseName = plugin;

        // Handle various input formats
        if (plugin.includes('/')) {
          // Handle formats like "elizaos/plugin-ton" or "elizaos-plugins/plugin-ton"
          const parts = plugin.split('/');
          baseName = parts[parts.length - 1];
        } else if (plugin.startsWith('@')) {
          // Handle scoped package format like "@elizaos/plugin-ton"
          const parts = plugin.split('/');
          if (parts.length > 1) {
            baseName = parts[1];
          }
        }

        // Remove any existing prefixes and ensure plugin- prefix is added
        baseName = baseName.replace(/^plugin-/, '');
        const pluginName = `plugin-${baseName}`;

        const installCommand = `bun add github:elizaos-plugins/${pluginName}`;

        // Use ANSI color codes
        const boldCyan = '\x1b[1;36m'; // Bold cyan for command
        const bold = '\x1b[1m'; // Bold for headers
        const reset = '\x1b[0m'; // Reset formatting

        // Print entire message with console.log to avoid timestamps and prefixes
        console.log(
          `\n📦 ${bold}To install ${pluginName}, you need to manually run this command:${reset}\n`
        );
        console.log(`  ${boldCyan}${installCommand}${reset}\n`);
        console.log(`Copy and paste the above command into your terminal to install the plugin.\n`);

        process.exit(0);
      }

      const repo = await getPluginRepository(plugin);

      if (!repo) {
        logger.error(`Plugin "${plugin}" not found in registry`);
        logger.info('\nYou can specify plugins in multiple formats:');
        logger.info('  - Just the name: ton');
        logger.info('  - With plugin- prefix: plugin-abc');
        logger.info('  - With organization: elizaos/plugin-abc');
        logger.info('  - Full package name: @elizaos-plugins/plugin-abc');
        logger.info('\nTry listing available plugins with:');
        logger.info('  npx elizaos project list-plugins');
        process.exit(1);
      }

      // Install from GitHub
      logger.info(`Installing ${plugin}...`);
      await installPlugin(repo, cwd);

      logger.success(`Successfully installed ${plugin}`);
    } catch (error) {
      handleError(error);
    }
  });

project
  .command('show-plugins')
  .description('List plugins found in the project dependencies')
  .action(async () => {
    try {
      const cwd = process.cwd();
      const packageJsonPath = path.join(cwd, 'package.json');

      if (!fs.existsSync(packageJsonPath)) {
        logger.error('No package.json found in the current directory.');
        logger.info('Please run this command from the root of an Eliza project.');
        process.exit(1);
      }

      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

      // Combine dependencies and devDependencies
      const dependencies = {
        ...(packageJson.dependencies || {}),
        ...(packageJson.devDependencies || {}),
      };

      const pluginNames = Object.keys(dependencies).filter((depName) => {
        // Regex to match typical Eliza plugin names
        // Matches: @elizaos/plugin-*, @elizaos-plugins/plugin-*, plugin-*
        return /^(@elizaos(-plugins)?\/)?plugin-.+/.test(depName);
      });

      if (pluginNames.length === 0) {
        logger.info('No Eliza plugins found in the project dependencies (package.json).');
      } else {
        logger.info('\nEliza plugins found in project dependencies:');
        pluginNames.sort().forEach((pluginName) => {
          logger.info(`  ${pluginName}`);
        });
        logger.info('');
      }
    } catch (error) {
      // Add specific error handling for JSON parsing
      if (error instanceof SyntaxError) {
        logger.error(`Error parsing package.json: ${error.message}`);
      } else {
        handleError(error);
      }
      process.exit(1);
    }
  });

project
  .command('remove-plugin')
  .description('Remove a plugin from the project')
  .argument('<plugin>', 'plugin name (e.g., "abc", "plugin-abc", "elizaos/plugin-abc")')
  .action(async (plugin, _opts) => {
    try {
      const cwd = process.cwd();

      // Check if we're running under npx (reusing same logic as add-plugin)
      const isNpx =
        process.env.npm_lifecycle_event === 'npx' ||
        process.env.npm_execpath?.includes('npx') ||
        process.argv[0]?.includes('npx') ||
        process.env.npm_config_user_agent?.includes('npm') ||
        process.env._?.includes('npx') ||
        !!process.env.npm_command;

      // If running under npx, provide clear instructions instead
      if (isNpx) {
        // Extract and normalize the plugin name
        let baseName = plugin;

        // Handle various input formats
        if (plugin.includes('/')) {
          // Handle formats like "elizaos/plugin-ton" or "elizaos-plugins/plugin-ton"
          const parts = plugin.split('/');
          baseName = parts[parts.length - 1];
        } else if (plugin.startsWith('@')) {
          // Handle scoped package format like "@elizaos/plugin-ton"
          const parts = plugin.split('/');
          if (parts.length > 1) {
            baseName = parts[1];
          }
        }

        // Remove any existing prefixes and ensure plugin- prefix is added
        baseName = baseName.replace(/^plugin-/, '');
        const pluginName = `plugin-${baseName}`;

        // For removing, we need the package name
        const removeCommand = `bun remove @elizaos/${pluginName} && rm -rf ${pluginName}`;

        // Use ANSI color codes
        const boldCyan = '\x1b[1;36m'; // Bold cyan for command
        const bold = '\x1b[1m'; // Bold for headers
        const reset = '\x1b[0m'; // Reset formatting

        // Print entire message with console.log to avoid timestamps and prefixes
        console.log(
          `\n🗑️ ${bold}To remove ${pluginName}, you need to manually run this command:${reset}\n`
        );
        console.log(`  ${boldCyan}${removeCommand}${reset}\n`);
        console.log(`Copy and paste the above command into your terminal to remove the plugin.\n`);

        process.exit(0);
      }

      // Uninstall package
      logger.info(`Removing ${plugin}...`);
      await execa('bun', ['remove', plugin], {
        cwd,
        stdio: 'inherit',
      });

      // Remove plugin directory if it exists
      const pluginDir = path.join(cwd, plugin.replace(/^@elizaos\//, '').replace(/^plugin-/, ''));
      if (fs.existsSync(pluginDir)) {
        logger.info(`Removing plugin directory ${pluginDir}...`);
        fs.rmSync(pluginDir, { recursive: true, force: true });
      }

      logger.success(`Successfully removed ${plugin}`);
    } catch (error) {
      handleError(error);
    }
  });
