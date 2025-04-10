import { handleError } from '@/src/utils/handle-error';
import { installPlugin } from '@/src/utils/install-plugin';
import { getPluginRepository } from '@/src/utils/registry/index';
import { logger } from '@elizaos/core';
import { Command } from 'commander';
import { execa } from 'execa';
import path from 'path';
import fs from 'fs';
import { logHeader } from '@/src/utils/helpers';
import { isRunningViaNpx } from '@/src/utils/package-manager';
import { getVersion } from '../displayBanner';

// --- Helper Functions ---

/** Reads and parses package.json, returning dependencies. */
const readPackageJson = (
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
 * Normalizes a plugin input string to a standard format, typically 'plugin-name'.
 * Used primarily for display and generating commands in npx instructions.
 */
const normalizePluginNameForDisplay = (pluginInput: string): string => {
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
const findPluginPackageName = (
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

      logHeader('Available plugins');
      for (const plugin of plugins) {
        console.log(`${plugin}`);
      }
      console.log('');
    } catch (error) {
      handleError(error);
    }
  });

project
  .command('add-plugin')
  .description('Add a plugin to the project')
  .argument('<plugin>', 'plugin name (e.g., "abc", "plugin-abc", "elizaos/plugin-abc")')
  .option('-n, --no-env-prompt', 'Skip prompting for environment variables')
  .option(
    '-b, --branch <branchName>',
    'Branch to install from when using monorepo source',
    'v2-develop'
  )
  .action(async (plugin, opts) => {
    try {
      const cwd = process.cwd();
      const isNpx = isRunningViaNpx(); // Use imported helper

      // Read package.json data
      const pkgData = readPackageJson(cwd);
      let installedPluginName: string | null = null;

      if (pkgData) {
        installedPluginName = findPluginPackageName(plugin, pkgData.allDependencies); // Use helper
        if (installedPluginName) {
          logger.info(`Plugin "${installedPluginName}" is already added to this project.`);
          process.exit(0);
        }
      }
      // If pkgData is null, readPackageJson already logged a warning

      // If running under npx, provide clear instructions instead
      if (isNpx) {
        const pluginName = normalizePluginNameForDisplay(plugin); // Use helper

        // Determine the appropriate tag based on the CLI version
        const cliVersion = getVersion();
        let versionTag = '@latest'; // Default to latest
        if (cliVersion.includes('alpha')) {
          versionTag = '@alpha';
        } else if (cliVersion.includes('beta')) {
          versionTag = '@beta';
        }

        console.log(`cliVersion: ${cliVersion}`);
        console.log(`versionTag: ${versionTag}`);

        // Show installation instructions for all approaches, including branch for monorepo
        const npmCommand = `bun add @elizaos/${pluginName}${versionTag}`;
        const gitCommand = `bun add git+https://github.com/elizaos/${pluginName}.git`;
        const monorepoCommand = `bun add git+https://github.com/elizaos/eliza.git#${opts.branch}&subdirectory=packages/${pluginName}`;

        // Use ANSI color codes
        const boldCyan = '\x1b[1;36m'; // Bold cyan for command
        const bold = '\x1b[1m'; // Bold for headers
        const reset = '\x1b[0m'; // Reset formatting

        // Print entire message with console.log to avoid timestamps and prefixes
        console.log(`\n📦 ${bold}To install ${pluginName}, try one of these commands:${reset}\n`);
        console.log(`Option 1 (npm registry):\n  ${boldCyan}${npmCommand}${reset}\n`);
        console.log(`Option 2 (dedicated GitHub repo):\n  ${boldCyan}${gitCommand}${reset}\n`);
        console.log(
          `Option 3 (monorepo subdirectory, branch: ${opts.branch}):\n  ${boldCyan}${monorepoCommand}${reset}\n`
        );

        process.exit(0);
      }

      // Determine the appropriate tag based on the CLI version
      const cliVersion = getVersion();
      let versionTag = '@latest'; // Default to latest
      if (cliVersion.includes('alpha')) {
        versionTag = '@alpha';
      } else if (cliVersion.includes('beta')) {
        versionTag = '@beta';
      }

      // Normalize name and construct npm package identifier
      const normalizedPluginName = normalizePluginNameForDisplay(plugin); // e.g., plugin-anthropic
      const npmPackageName = `@elizaos/${normalizedPluginName}`; // e.g., @elizaos/plugin-anthropic
      const npmPackageNameWithTag = `${npmPackageName}${versionTag}`; // e.g., @elizaos/plugin-anthropic@alpha

      console.info(`Attempting to install ${npmPackageNameWithTag} from npm registry...`);

      // Try installing directly from npm first using the determined tag
      let success = await installPlugin(
        npmPackageName, // Pass base name
        cwd,
        versionTag.substring(1), // Pass tag without '@' as version hint
        opts.branch // Pass branch for potential monorepo fallback within installPlugin
      );

      if (success) {
        console.log(`Successfully installed ${npmPackageNameWithTag}`);
        process.exit(0);
      }

      // --- Fallback Logic ---
      console.warn(
        `Failed to install ${npmPackageNameWithTag} directly from npm. Trying registry lookup...`
      );

      // Proceed with installation if not running under npx and plugin not found
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

      // Install plugin using our centralized function, passing the branch option
      console.info(`Installing ${repo}...`); // Use repo directly
      success = await installPlugin(repo, cwd, undefined, opts.branch); // Use 'success' variable declared above

      if (success) {
        console.log(`Successfully installed ${repo}`); // Use repo directly
      } else {
        console.error(`Failed to install ${repo}`); // Use repo directly
        process.exit(1);
      }
    } catch (error) {
      handleError(error);
    }
  });

project
  .command('installed-plugins')
  .description('List plugins found in the project dependencies')
  .action(async () => {
    try {
      const cwd = process.cwd();
      const pkgData = readPackageJson(cwd); // Use helper

      if (!pkgData) {
        // Error handled within readPackageJson, but provide context here
        console.error('Could not read or parse package.json.');
        console.info('Please run this command from the root of an Eliza project.');
        process.exit(1);
      }

      const pluginNames = Object.keys(pkgData.allDependencies).filter((depName) => {
        // Regex to match typical Eliza plugin names
        // Matches: @elizaos/plugin-*, @elizaos-plugins/plugin-*, plugin-*
        return /^(@elizaos(-plugins)?\/)?plugin-.+/.test(depName);
      });

      if (pluginNames.length === 0) {
        console.log('No Eliza plugins found in the project dependencies (package.json).');
      } else {
        logHeader('Plugins Added:');
        pluginNames.sort().forEach((pluginName) => {
          console.log(`${pluginName}`);
        });
        console.log('');
      }
    } catch (error) {
      // Keep specific JSON error handling here as readPackageJson only warns
      if (error instanceof SyntaxError) {
        console.error(`Error parsing package.json: ${error.message}`);
        process.exit(1); // Exit after specific syntax error
      }
      // General errors should be handled by handleError
      handleError(error);
      // handleError might not exit, ensure we exit on other errors too
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
      const isNpx = isRunningViaNpx(); // Use imported helper

      // If running under npx, provide clear instructions instead
      if (isNpx) {
        const pluginName = normalizePluginNameForDisplay(plugin); // Use helper
        const packageName = `@elizaos/${pluginName}`; // Assume standard scope for removal instructions

        // For removing, we need the package name and potentially the directory
        // Assume directory matches pluginName for simplicity in instructions
        const removeCommand = `bun remove ${packageName} && rm -rf ${pluginName}`;

        // Use ANSI color codes
        const boldCyan = '\x1b[1;36m'; // Bold cyan for command
        const bold = '\x1b[1m'; // Bold for headers
        const reset = '\x1b[0m'; // Reset formatting

        console.log(
          `\n[x] ${bold}To remove ${pluginName}, you need to manually run this command:${reset}\n`
        );
        console.log(`  ${boldCyan}${removeCommand}${reset}\n`);
        console.log(`Copy and paste the above command into your terminal to remove the plugin.\n`);

        process.exit(0);
      }

      // Read package.json data
      const pkgData = readPackageJson(cwd);
      if (!pkgData) {
        console.error(
          'Could not read or parse package.json. Cannot determine which package to remove.'
        );
        process.exit(1);
      }

      // Find the exact package name to remove
      const packageNameToRemove = findPluginPackageName(plugin, pkgData.allDependencies); // Use helper

      if (!packageNameToRemove) {
        logger.warn(`Plugin matching "${plugin}" not found in project dependencies.`);
        // Optionally list installed plugins here?
        // await project.commands.find(cmd => cmd.name() === 'installed-plugins')?.execute([], { Help: Command}); // Might be too complex
        console.info('\nCheck installed plugins using: elizaos project installed-plugins');
        process.exit(0); // Exit gracefully if not found
      }

      // Uninstall package
      console.info(`Removing ${packageNameToRemove}...`);
      try {
        await execa('bun', ['remove', packageNameToRemove], {
          cwd,
          stdio: 'inherit',
        });
      } catch (execError) {
        logger.error(`Failed to run 'bun remove ${packageNameToRemove}': ${execError.message}`);
        // Check if it might be because the package wasn't actually installed
        // (e.g., if `findPluginPackageName` found it in package.json but `bun remove` fails)
        if (execError.stderr?.includes('not found')) {
          logger.info(
            `'bun remove' indicated package was not found. Continuing with directory removal attempt.`
          );
        } else {
          handleError(execError); // Handle other execution errors
          process.exit(1); // Exit on failure
        }
      }

      // Get base name for directory removal (similar logic to normalization)
      let baseName = packageNameToRemove;
      if (packageNameToRemove.includes('/')) {
        const parts = packageNameToRemove.split('/');
        baseName = parts[parts.length - 1];
      }
      // Standardize directory name check: remove potential scope and ensure 'plugin-' prefix
      baseName = baseName.replace(/^plugin-/, '');
      const dirNameToRemove = `plugin-${baseName}`;

      // Check only the standard directory name convention
      const pluginDir = path.join(cwd, dirNameToRemove);
      if (fs.existsSync(pluginDir)) {
        console.info(`Removing plugin directory ${pluginDir}...`);
        try {
          fs.rmSync(pluginDir, { recursive: true, force: true });
        } catch (rmError) {
          logger.error(`Failed to remove directory ${pluginDir}: ${rmError.message}`);
          // Don't necessarily exit, maybe just warn
        }
      } else {
        // Optionally check the non-prefixed name too? Less standard.
        const nonPrefixedDir = path.join(cwd, baseName);
        if (fs.existsSync(nonPrefixedDir)) {
          console.info(`Removing non-standard plugin directory ${nonPrefixedDir}...`);
          try {
            fs.rmSync(nonPrefixedDir, { recursive: true, force: true });
          } catch (rmError) {
            logger.error(`Failed to remove directory ${nonPrefixedDir}: ${rmError.message}`);
          }
        }
      }

      console.log(`Successfully removed ${packageNameToRemove}`);
    } catch (error) {
      // Catch errors not handled by specific try/catch blocks
      handleError(error);
      process.exit(1); // Ensure exit on unhandled errors
    }
  });
