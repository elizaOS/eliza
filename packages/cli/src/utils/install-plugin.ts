import { logger } from '@elizaos/core';
import { execa } from 'execa';
import { getPluginVersion } from './registry';
import { isGlobalInstallation, getPackageManager, getInstallCommand } from './package-manager';

/**
 * Check if we're running via npx
 * @returns {boolean} - Whether we're running through npx
 */
function isRunningViaNpx(): boolean {
  // Check if we're running from npx cache directory or if NPX_COMMAND is set
  return (
    process.env.npm_execpath?.includes('npx') ||
    process.argv[1]?.includes('npx') ||
    process.env.NPX_COMMAND !== undefined
  );
}

/**
 * Check if we're running via bunx
 * @returns {boolean} - Whether we're running through bunx
 */
function isRunningViaBunx(): boolean {
  // Check if we're running through bunx
  return (
    process.argv[1]?.includes('bunx') ||
    process.env.BUN_INSTALL === '1' ||
    process.argv[0]?.includes('bun')
  );
}

/**
 * Asynchronously installs a plugin to a specified directory.
 *
 * @param {string} repository - The repository URL of the plugin to install.
 * @param {string} cwd - The current working directory where the plugin will be installed.
 * @param {string} version - The specific version of the plugin to install.
 * @returns {Promise<boolean>} - A Promise that resolves to true if the plugin is successfully installed, or false otherwise.
 */
export async function installPlugin(
  repository: string,
  cwd: string,
  version?: string
): Promise<boolean> {
  // Mark this plugin as installed to ensure we don't get into an infinite loop
  logger.info(`Installing plugin: ${repository}`);

  // Check if the CLI is running from a global installation
  const isGlobal = isGlobalInstallation();

  // Decide which package manager to use
  const packageManager = getPackageManager();

  if (isGlobal) {
    logger.info(`Detected global CLI installation, installing plugin globally...`);
  }

  logger.debug(`Using package manager: ${packageManager}`);

  // Prepare the install command based on package manager and whether it's global
  const installCommand = getInstallCommand(packageManager, isGlobal);

  if (version) {
    try {
      await execa(packageManager, [...installCommand, `${repository}@${version}`], {
        cwd,
        stdio: 'inherit',
      });
      return true;
    } catch (error) {
      logger.debug(`Plugin not found on npm, trying to install from registry...`);
    }
  }
  try {
    // Clean repository URL
    let repoUrl = repository;
    if (repoUrl.startsWith('git+')) {
      repoUrl = repoUrl.substring(4);
    }
    if (repoUrl.endsWith('.git')) {
      repoUrl = repoUrl.slice(0, -4);
    }

    // Get specific version if requested
    let installVersion = '';
    if (version) {
      const resolvedVersion = await getPluginVersion(repoUrl, version);
      if (!resolvedVersion) {
        logger.error(`Version ${version} not found for plugin ${repoUrl}`);
        return false;
      }
      installVersion = `#${resolvedVersion}`;
    }

    // Install using the appropriate package manager
    await execa(packageManager, [...installCommand, `${repoUrl}${installVersion}`], {
      cwd,
      stdio: 'inherit',
    });

    return true;
  } catch (error) {
    logger.error(`Failed to install plugin ${repository}:`, error);
    return false;
  }
}
