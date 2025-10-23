import { handleError } from '@/src/utils';
import { Command } from 'commander';

// Import actions
import { addPlugin } from './actions/install';
import { removePlugin } from './actions/remove';
import { listAvailablePlugins, listInstalledPlugins } from './actions/list';

// Import types
import { ListPluginsOptions, AddPluginOptions } from './types';

export const plugins = new Command()
  .name('plugins')
  .description('Manage ElizaOS plugins')
  .action(() => {
    // Show help automatically if no subcommand is specified
    plugins.help();
  });

export const pluginsCommand = plugins
  .command('list')
  .aliases(['l', 'ls'])
  .description('List available plugins to install into the project (shows v1.x plugins by default)')
  .option('--all', 'List all plugins from the registry with detailed version info')
  .option('--v0', 'List only v0.x compatible plugins')
  .action(async (opts: ListPluginsOptions) => {
    try {
      await listAvailablePlugins(opts);
    } catch (error) {
      handleError(error);
    }
  });

plugins
  .command('add')
  .alias('install')
  .description('Add a plugin to the project')
  .argument('<plugin>', 'plugin name (e.g., "abc", "plugin-abc", "elizaos/plugin-abc")')
  .option('-s, --skip-env-prompt', 'Skip prompting for environment variables')
  .option('--skip-verification', 'Skip plugin import verification after installation')
  .option('-b, --branch <branchName>', 'Branch to install from when using monorepo source', 'main')
  .option('-T, --tag <tagname>', 'Specify a tag to install (e.g., beta)')
  .action(async (pluginArg: string, opts: AddPluginOptions) => {
    try {
      await addPlugin(pluginArg, opts);
    } catch (error) {
      handleError(error);
    }
  });

plugins
  .command('installed-plugins')
  .description('List plugins found in the project dependencies')
  .action(async () => {
    try {
      await listInstalledPlugins();
    } catch (error) {
      if (error instanceof SyntaxError) {
        console.error(`Error parsing package.json: ${error.message}`);
        process.exit(1);
      }
      handleError(error);
      process.exit(1);
    }
  });

plugins
  .command('remove')
  .aliases(['delete', 'del', 'rm'])
  .description('Remove a plugin from the project')
  .argument('<plugin>', 'plugins name (e.g., "abc", "plugin-abc", "elizaos/plugin-abc")')
  .action(async (plugin: string, _opts) => {
    try {
      await removePlugin(plugin);
    } catch (error) {
      handleError(error);
      process.exit(1);
    }
  });

// Re-export for backward compatibility
export * from './actions/install';
export * from './actions/remove';
export * from './actions/list';
export * from './types';
export * from './utils/naming';
