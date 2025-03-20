import { handleError } from '@/src/utils/handle-error';
import { installPlugin } from '@/src/utils/install-plugin';
import {
  getLocalRegistryIndex,
  getPluginRepository,
  getRegistryIndex,
} from '@/src/utils/registry/index';
import { logger } from '@elizaos/core';
import { Command } from 'commander';
import { execa } from 'execa';

export const project = new Command().name('project').description('Manage an ElizaOS project');

project
  .command('list-plugins')
  .description('list available plugins to install into the project')
  .option('-t, --type <type>', 'filter by type (adapter, client, plugin)')
  .action(async (opts) => {
    try {
      // Try to get registry without GitHub credentials first
      let registry;
      try {
        registry = await getLocalRegistryIndex();
      } catch (error) {
        // If that fails, try with credentials as a backup
        logger.debug('Failed to fetch registry without credentials, trying authenticated method');
        registry = await getRegistryIndex();
      }

      const plugins = Object.keys(registry)
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
  .description('add a plugin to the project')
  .argument('<plugin>', 'plugin name (e.g., "ton", "plugin-abc", "elizaos/plugin-abc")')
  .option('--no-env-prompt', 'Skip prompting for environment variables')
  .action(async (plugin, opts) => {
    try {
      const cwd = process.cwd();

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
  .command('remove-plugin')
  .description('remove a plugin from the project')
  .argument('<plugin>', 'plugin name')
  .action(async (plugin, _opts) => {
    try {
      const cwd = process.cwd();

      // Uninstall package
      logger.info(`Removing ${plugin}...`);
      await execa('bun', ['remove', plugin], {
        cwd,
        stdio: 'inherit',
      });

      logger.success(`Successfully removed ${plugin}`);
    } catch (error) {
      handleError(error);
    }
  });
