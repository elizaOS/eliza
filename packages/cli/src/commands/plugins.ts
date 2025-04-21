import { handleError } from '@/src/utils/handle-error';
import { installPlugin } from '@/src/utils/install-plugin';
import { getPluginRepository } from '@/src/utils/registry/index';
import { logger } from '@elizaos/core';
import { Command } from 'commander';
import { execa } from 'execa';
import path from 'node:path';
import fs from 'node:fs';
import { logHeader } from '@/src/utils/helpers';
import { isRunningViaNpx } from '@/src/utils/package-manager';
import { getVersion } from '../displayBanner';

// --- Helper Functions ---

/** Reads and parses package.json, returning dependencies. */
export const readPackageJson = (
  cwd: string
): {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  allDependencies: Record<string, string>;
} | null => {
  const packageJsonPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }
  try {
    const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent);
    const dependencies = packageJson.dependencies || {};
    const devDependencies = packageJson.devDependencies || {};
    const allDependencies = { ...dependencies, ...devDependencies };
    return { dependencies, devDependencies, allDependencies };
  } catch (error) {
    if (error instanceof SyntaxError) {
      logger.warn(`Could not parse package.json: ${error.message}`);
    } else {
      logger.warn(`Error reading package.json: ${error.message}`); // More generic warning
    }
    return null; // Indicate failure to read/parse
  }
};

/**
 * Normalizes a plugins input string to a standard format, typically 'plugin-name'.
 * Used primarily for display and generating commands in npx instructions.
 */
export const normalizePluginNameForDisplay = (pluginInput: string): string => {
  let baseName = pluginInput;

  // Handle scoped formats like "@scope/plugin-name" or "scope/plugin-name"
  if (pluginInput.includes('/')) {
    const parts = pluginInput.split('/');
    baseName = parts[parts.length - 1];
  }
  // Remove potential scope from "@plugin-name" - less common but possible
  else if (pluginInput.startsWith('@')) {
    const parts = pluginInput.split('/'); // Re-split in case it was just "@plugin-name"
    if (parts.length > 1) {
      baseName = parts[1];
    } else {
      // Assume it's like "@something" without a scope/name separator - maybe log a warning?
      // For now, let's just take the part after '@'
      baseName = pluginInput.substring(1);
    }
  }

  // Ensure it starts with 'plugin-' and remove duplicates if necessary
  baseName = baseName.replace(/^plugin-/, ''); // Remove existing prefix first
  return `plugin-${baseName}`; // Add the prefix back
};

/** Finds the actual package name in dependencies based on various input formats. */
export const findPluginPackageName = (
  pluginInput: string,
  allDependencies: Record<string, string>
): string | null => {
  // Normalize the input to a base form (e.g., 'abc' from 'plugin-abc')
  let normalizedBase = pluginInput.startsWith('@')
    ? pluginInput.split('/')[1] || pluginInput
    : pluginInput;
  normalizedBase = normalizedBase.replace(/^plugin-/, ''); // Remove prefix if present

  // Potential package names to check
  const possibleNames = [
    pluginInput, // Check the raw input first
    `@elizaos/plugin-${normalizedBase}`,
    `@elizaos-plugins/plugin-${normalizedBase}`, // Check alternative scope
    `plugin-${normalizedBase}`,
    `@elizaos/${normalizedBase}`, // Might be needed if input was 'plugin-abc' -> base 'abc' -> check '@elizaos/abc'
    `@elizaos-plugins/${normalizedBase}`,
  ];

  for (const name of possibleNames) {
    if (allDependencies[name]) {
      return name; // Return the first matching key found in dependencies
    }
  }

  return null; // Not found
};

// --- End Helper Functions ---

export const plugins = new Command()
  .name('plugins')
  .description('Manage ElizaOS plugins')
  .option('--help', 'Show help for plugins command')
  .action(function () {
    this.help();
  });

export const pluginsCommand = plugins
  .command('list')
  .aliases(['l', 'ls'])
  .description('List available plugins to install into the project')
  .option('-t, --type <type>', 'filter by type (adapter, client, plugin)')
  .action(async (opts) => {
    try {
      // Temporarily return hardcoded plugins as an array
      const hardcodedPlugins = [
        '@elizaos/plugin-bootstrap',
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

      const availablePlugins = hardcodedPlugins
        .filter((name) => !opts.type || name.includes(opts.type))
        .sort();

      logHeader('Available plugins');
      for (const pluginName of availablePlugins) {
        console.log(`${pluginName}`);
      }
      console.log('');
    } catch (error) {
      handleError(error);
    }
  });

plugins
  .command('add')
  .alias('install')
  .description('Add a plugins to the project')
  .argument('<plugin>', 'plugins name (e.g., "abc", "plugin-abc", "elizaos/plugin-abc")')
  .option('-n, --no-env-prompt', 'Skip prompting for environment variables')
  .option(
    '-b, --branch <branchName>',
    'Branch to install from when using monorepo source',
    'v2-develop'
  )
  .action(async (plugin, opts) => {
    const cwd = process.cwd();
    const isNpx = isRunningViaNpx();
    const pkgData = readPackageJson(cwd);

    if (!isNpx && !pkgData) {
      logger.error(
        'Command must be run inside an Eliza project directory (no package.json found).'
      );
      process.exit(1);
    }

    try {
      if (pkgData) {
        const installedPluginName = findPluginPackageName(plugin, pkgData.allDependencies);
        if (installedPluginName) {
          logger.info(`Plugin "${installedPluginName}" is already added to this project.`);
          process.exit(0);
        }
      }

      if (isNpx) {
        const pluginName = normalizePluginNameForDisplay(plugin);
        const cliVersion = getVersion();
        let versionTag = '@latest';
        if (cliVersion.includes('alpha')) {
          versionTag = '@alpha';
        } else if (cliVersion.includes('beta')) {
          versionTag = '@beta';
        }

        console.log(`cliVersion: ${cliVersion}`);
        console.log(`versionTag: ${versionTag}`);

        const npmCommand = `bun add @elizaos/${pluginName}${versionTag}`;
        const gitCommand = `bun add git+https://github.com/elizaos/${pluginName}.git`;
        const monorepoCommand = `bun add git+https://github.com/elizaos/eliza.git#${opts.branch}&subdirectory=packages/${pluginName}`;

        const boldCyan = '\x1b[1;36m';
        const bold = '\x1b[1m';
        const reset = '\x1b[0m';

        console.log(`\n📦 ${bold}To install ${pluginName}, try one of these commands:${reset}\n`);
        console.log(`Option 1 (npm registry):\n  ${boldCyan}${npmCommand}${reset}\n`);
        console.log(`Option 2 (dedicated GitHub repo):\n  ${boldCyan}${gitCommand}${reset}\n`);
        console.log(
          `Option 3 (monorepo subdirectory, branch: ${opts.branch}):\n  ${boldCyan}${monorepoCommand}${reset}\n`
        );

        process.exit(0);
      }

      const cliVersion = getVersion();
      let versionTag = '@latest';
      if (cliVersion.includes('alpha')) {
        versionTag = '@alpha';
      } else if (cliVersion.includes('beta')) {
        versionTag = '@beta';
      }

      const normalizedPluginName = normalizePluginNameForDisplay(plugin);
      const npmPackageName = `@elizaos/${normalizedPluginName}`;
      const npmPackageNameWithTag = `${npmPackageName}${versionTag}`;

      console.info(`Attempting to install ${npmPackageNameWithTag} from npm registry...`);

      let success = await installPlugin(npmPackageName, cwd, versionTag.substring(1), opts.branch);

      if (success) {
        console.log(`Successfully installed ${npmPackageNameWithTag}`);
        process.exit(0);
      }

      console.warn(
        `Failed to install ${npmPackageNameWithTag} directly from npm. Trying registry lookup...`
      );

      const repo = await getPluginRepository(plugin);

      if (!repo) {
        console.error(`Plugin "${plugin}" not found in registry`);
        console.info('\nYou can specify plugins in multiple formats:');
        console.info('  - Just the name: ton');
        console.info('  - With plugin- prefix: plugin-abc');
        console.info('  - With organization: elizaos/plugin-abc');
        console.info('  - Full package name: @elizaos-plugins/plugin-abc');
        console.info('\nTry listing available plugins with:');
        console.info('  npx elizaos project list-plugins');
        process.exit(1);
      }

      console.info(`Installing ${repo}...`);
      success = await installPlugin(repo, cwd, undefined, opts.branch);

      if (success) {
        console.log(`Successfully installed ${repo}`);
      } else {
        console.error(`Failed to install ${repo}`);
        process.exit(1);
      }
    } catch (error) {
      handleError(error);
    }
  });

plugins
  .command('installed-plugins')
  .description('List plugins found in the project dependencies')
  .action(async () => {
    try {
      const cwd = process.cwd();
      const pkgData = readPackageJson(cwd);

      if (!pkgData) {
        console.error('Could not read or parse package.json.');
        console.info('Please run this command from the root of an Eliza project.');
        process.exit(1);
      }

      const pluginNames = Object.keys(pkgData.allDependencies).filter((depName) => {
        return /^(@elizaos(-plugins)?\/)?plugin-.+/.test(depName);
      });

      if (pluginNames.length === 0) {
        console.log('No Eliza plugins found in the project dependencies (package.json).');
      } else {
        logHeader('Plugins Added:');
        for (const pluginName of pluginNames) {
          console.log(`${pluginName}`);
        }
        console.log('');
      }
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
  .action(async (plugin, _opts) => {
    try {
      const cwd = process.cwd();
      const isNpx = isRunningViaNpx();

      if (isNpx) {
        const pluginName = normalizePluginNameForDisplay(plugin);
        const packageName = `@elizaos/${pluginName}`;

        const removeCommand = `bun remove ${packageName} && rm -rf ${pluginName}`;

        const boldCyan = '\x1b[1;36m';
        const bold = '\x1b[1m';
        const reset = '\x1b[0m';

        console.log(
          `\n[x] ${bold}To remove ${pluginName}, you need to manually run this command:${reset}\n`
        );
        console.log(`  ${boldCyan}${removeCommand}${reset}\n`);
        console.log('Copy and paste the above command into your terminal to remove the plugin.\n');

        process.exit(0);
      }

      const pkgData = readPackageJson(cwd);
      if (!pkgData) {
        console.error(
          'Could not read or parse package.json. Cannot determine which package to remove.'
        );
        process.exit(1);
      }

      const packageNameToRemove = findPluginPackageName(plugin, pkgData.allDependencies);

      if (!packageNameToRemove) {
        logger.warn(`Plugin matching "${plugin}" not found in project dependencies.`);
        console.info('\nCheck installed plugins using: elizaos project installed-plugins');
        process.exit(0);
      }

      console.info(`Removing ${packageNameToRemove}...`);
      try {
        await execa('bun', ['remove', packageNameToRemove], {
          cwd,
          stdio: 'inherit',
        });
      } catch (execError) {
        logger.error(`Failed to run 'bun remove ${packageNameToRemove}': ${execError.message}`);
        if (execError.stderr?.includes('not found')) {
          logger.info(
            `'bun remove' indicated package was not found. Continuing with directory removal attempt.`
          );
        } else {
          handleError(execError);
          process.exit(1);
        }
      }

      let baseName = packageNameToRemove;
      if (packageNameToRemove.includes('/')) {
        const parts = packageNameToRemove.split('/');
        baseName = parts[parts.length - 1];
      }
      baseName = baseName.replace(/^plugin-/, '');
      const dirNameToRemove = `plugin-${baseName}`;

      const pluginDir = path.join(cwd, dirNameToRemove);
      if (fs.existsSync(pluginDir)) {
        console.info(`Removing plugins directory ${pluginDir}...`);
        try {
          fs.rmSync(pluginDir, { recursive: true, force: true });
        } catch (rmError) {
          logger.error(`Failed to remove directory ${pluginDir}: ${rmError.message}`);
        }
      } else {
        const nonPrefixedDir = path.join(cwd, baseName);
        if (fs.existsSync(nonPrefixedDir)) {
          console.info(`Removing non-standard plugins directory ${nonPrefixedDir}...`);
          try {
            fs.rmSync(nonPrefixedDir, { recursive: true, force: true });
          } catch (rmError) {
            logger.error(`Failed to remove directory ${nonPrefixedDir}: ${rmError.message}`);
          }
        }
      }

      console.log(`Successfully removed ${packageNameToRemove}`);
    } catch (error) {
      handleError(error);
      process.exit(1);
    }
  });
