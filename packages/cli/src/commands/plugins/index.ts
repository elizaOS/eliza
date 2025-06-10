import { handleError } from '@/src/utils';
import { Command } from 'commander';

// Import actions
import { addPlugin } from './actions/install';
import { removePlugin } from './actions/remove';
import { listAvailablePlugins, listInstalledPlugins } from './actions/list';
import { upgradePlugin } from './actions/upgrade';
import { generatePlugin } from './actions/generate';

// Import types
import { ListPluginsOptions, AddPluginOptions, UpgradePluginOptions, GeneratePluginOptions } from './types';

export const plugins = new Command()
  .name('plugins')
  .description('Manage ElizaOS plugins')
  .action(function () {
    // Show help automatically if no subcommand is specified
    this.help({ showGlobals: false });
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
  .argument('<plugin>', 'plugins name (e.g., "abc", "plugin-abc", "elizaos/plugin-abc")')
  .option('-s, --skip-env-prompt', 'Skip prompting for environment variables')
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
  .description('Remove a plugins from the project')
  .argument('<plugin>', 'plugins name (e.g., "abc", "plugin-abc", "elizaos/plugin-abc")')
  .action(async (plugin: string, _opts) => {
    try {
      await removePlugin(plugin);
    } catch (error) {
      handleError(error);
      process.exit(1);
    }
  });

plugins
  .command('upgrade')
  .description('Upgrade a plugin from version 0.x to 1.x using AI-powered migration')
  .argument('<path>', 'GitHub repository URL or local folder path')
  .option('--api-key <key>', 'Anthropic API key (or use ANTHROPIC_API_KEY env var)')
  .option('--skip-tests', 'Skip test validation loop')
  .option('--skip-validation', 'Skip production readiness validation')
  .action(async (pluginPath: string, opts: UpgradePluginOptions) => {
    await upgradePlugin(pluginPath, opts);
  });

plugins
  .command('generate')
  .description('Generate a new plugin using AI-powered code generation')
  .option('--api-key <key>', 'Anthropic API key (or use ANTHROPIC_API_KEY env var)')
  .option('--skip-tests', 'Skip test validation loop')
  .option('--skip-validation', 'Skip production readiness validation')
  .option('--skip-prompts', 'Skip interactive prompts (requires --spec-file)')
  .option('--spec-file <path>', 'Path to JSON file containing plugin specification')
  .action(async (opts: GeneratePluginOptions) => {
    await generatePlugin(opts);
  });

// Re-export for backward compatibility
export * from './actions/install';
export * from './actions/remove'; 
export * from './actions/list';
export * from './actions/upgrade';
export * from './actions/generate';
export * from './types';
export * from './utils/naming';