import { installPlugin } from '@/src/utils';
import { fetchPluginRegistry } from '@/src/utils/plugin-discovery';
import { normalizePluginName } from '@/src/utils/registry';
import { detectDirectoryType } from '@/src/utils/directory-detection';
import { logger } from '@elizaos/core';
import { AddPluginOptions } from '../types';
import { extractPackageName, findPluginPackageName } from '../utils/naming';
import { promptForPluginEnvVars } from '../utils/env-vars';
import { getDependenciesFromDirectory } from '../utils/directory';
import * as clack from '@clack/prompts';
import colors from 'yoctocolors';
// Character updater imports removed - reverting to project-scoped plugins

/**
 * Show consolidated success message with next steps
 */
function showInstallationSuccess(pluginName: string): void {
  const message =
    `${colors.green('✓')} Plugin installed successfully!\n\n` +
    `${colors.bold('Next steps:')}\n` +
    `1. Add ${colors.cyan(`"${pluginName}"`)} to your character file's plugins array:\n\n` +
    `   ${colors.gray('{')}${colors.dim('\n')}` +
    `     ${colors.green('"name"')}: ${colors.yellow('"YourAgent"')},${colors.dim('\n')}` +
    `     ${colors.green('"plugins"')}: [${colors.cyan(`"${pluginName}"`)}],${colors.dim('\n')}` +
    `     ${colors.gray('...')}${colors.dim('\n')}` +
    `   ${colors.gray('}')}\n\n` +
    `2. Restart your application to load the plugin\n` +
    `3. Configure any required environment variables\n` +
    `4. Check the plugin documentation for additional setup`;

  clack.outro(message);
}

/**
 * Install a plugin from GitHub repository
 */
export async function installPluginFromGitHub(
  plugin: string,
  cwd: string,
  opts: AddPluginOptions
): Promise<void> {
  const githubRegex = /^(?:github:)?([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)(?:#([a-zA-Z0-9_.-]+))?$/;
  const githubMatch = plugin.match(githubRegex);

  if (!githubMatch) {
    throw new Error('Invalid GitHub repository format');
  }

  const [, owner, repo, ref] = githubMatch;
  const githubSpecifier = `github:${owner}/${repo}${ref ? `#${ref}` : ''}`;
  const pluginNameForPostInstall = repo;

  const success = await installPlugin(githubSpecifier, cwd, undefined, opts.skipVerification);

  if (success) {
    logger.info(`Successfully installed ${pluginNameForPostInstall} from ${githubSpecifier}.`);

    const packageName = extractPackageName(plugin);

    // Prompt for environment variables if not skipped
    if (!opts.skipEnvPrompt) {
      // Brief pause to ensure installation logs are complete
      await new Promise((resolve) => setTimeout(resolve, 500));
      console.log(`\n🔧 Checking environment variables for ${packageName}...`);
      try {
        await promptForPluginEnvVars(packageName, cwd);
      } catch (error) {
        logger.warn(
          `Warning: Could not prompt for environment variables: ${error instanceof Error ? error.message : String(error)}`
        );
        // Don't fail the installation if env prompting fails
      }
    } else {
      console.log(`\n⏭️  Skipping environment variable prompts due to --skip-env-prompt flag`);
    }

    // Show consolidated next steps
    showInstallationSuccess(packageName);

    process.exit(0);
  } else {
    logger.error(`Failed to install plugin from ${githubSpecifier}.`);
    process.exit(1);
  }
}

/**
 * Install a plugin from registry
 */
export async function installPluginFromRegistry(
  plugin: string,
  cwd: string,
  opts: AddPluginOptions
): Promise<void> {
  const cachedRegistry = await fetchPluginRegistry();
  if (!cachedRegistry || !cachedRegistry.registry) {
    logger.error('Plugin registry cache not found. Please run "elizaos plugins update" first.');
    process.exit(1);
  }

  const possibleNames = normalizePluginName(plugin);
  const pluginKey = possibleNames.find((name) => cachedRegistry.registry[name]);

  const targetName = pluginKey || plugin;

  const registryInstallResult = await installPlugin(
    targetName,
    cwd,
    opts.tag,
    opts.skipVerification
  );

  if (registryInstallResult) {
    console.log(`Successfully installed ${targetName}`);

    // Refresh dependencies after installation to find the actual installed package name
    const updatedDependencies = getDependenciesFromDirectory(cwd);
    const actualPackageName =
      findPluginPackageName(targetName, updatedDependencies || {}) || targetName;

    // Prompt for environment variables if not skipped
    if (!opts.skipEnvPrompt) {
      // Brief pause to ensure installation logs are complete
      await new Promise((resolve) => setTimeout(resolve, 500));

      console.log(`\n🔧 Checking environment variables for ${actualPackageName}...`);
      try {
        await promptForPluginEnvVars(actualPackageName, cwd);
      } catch (error) {
        logger.warn(
          `Warning: Could not prompt for environment variables: ${error instanceof Error ? error.message : String(error)}`
        );
        // Don't fail the installation if env prompting fails
      }
    } else {
      console.log(`\n⏭️  Skipping environment variable prompts due to --skip-env-prompt flag`);
    }

    // Show consolidated next steps
    showInstallationSuccess(actualPackageName);

    process.exit(0);
  }

  console.error(`Failed to install ${targetName} from registry.`);
  process.exit(1);
}

/**
 * Main plugin installation function
 */
export async function addPlugin(pluginArg: string, opts: AddPluginOptions): Promise<void> {
  // Validate plugin name is not empty or whitespace
  if (!pluginArg || !pluginArg.trim()) {
    logger.error('Plugin name cannot be empty or whitespace-only.');
    logger.info(
      'Please provide a valid plugin name (e.g., "openai", "plugin-anthropic", "@elizaos/plugin-sql")'
    );
    process.exit(1);
  }

  const cwd = process.cwd();
  const directoryInfo = detectDirectoryType(cwd);

  if (!directoryInfo || !directoryInfo.hasPackageJson) {
    logger.error(
      `Command must be run inside an ElizaOS project directory. This directory is: ${directoryInfo?.type || 'invalid or inaccessible'}`
    );
    process.exit(1);
  }

  const allDependencies = getDependenciesFromDirectory(cwd);
  if (!allDependencies) {
    logger.error('Could not read dependencies from package.json');
    process.exit(1);
  }

  let plugin = pluginArg;

  // --- Convert full GitHub HTTPS URL to shorthand ---
  const httpsGitHubUrlRegex =
    // eslint-disable-next-line no-useless-escape
    /^https?:\/\/github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?(?:(?:#|\/tree\/|\/commit\/)([a-zA-Z0-9_.-]+))?\/?$/;
  const httpsMatch = plugin.match(httpsGitHubUrlRegex);

  if (httpsMatch) {
    const [, owner, repo, ref] = httpsMatch;
    plugin = `github:${owner}/${repo}${ref ? `#${ref}` : ''}`;
  }

  const installedPluginName = findPluginPackageName(plugin, allDependencies);
  if (installedPluginName) {
    logger.info(`Plugin "${installedPluginName}" is already added to this project.`);
    process.exit(0);
  }

  // Check if it's a GitHub plugin
  const githubRegex = /^(?:github:)?([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)(?:#([a-zA-Z0-9_.-]+))?$/;
  if (githubRegex.test(plugin)) {
    await installPluginFromGitHub(plugin, cwd, opts);
  } else {
    await installPluginFromRegistry(plugin, cwd, opts);
  }
}
