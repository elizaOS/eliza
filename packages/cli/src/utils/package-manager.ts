import { logger } from '@elizaos/core';
import { execa } from 'execa';
import { UserEnvironment } from './user-environment';

/**
 * Detects and returns the preferred package manager for the current environment.
 *
 * @returns A promise that resolves to the name of the package manager to use: 'npm', 'yarn', 'pnpm', or 'bun'.
 *
 * @remark Defaults to 'bun' if the package manager cannot be determined.
 */
export async function getPackageManager(): Promise<string> {
  const envInfo = await UserEnvironment.getInstanceInfo();

  logger.debug('[PackageManager] Detecting package manager');
  return envInfo.packageManager.name === 'unknown' ? 'bun' : envInfo.packageManager.name;
}

/**
 * Check if the CLI is running from a global installation
 * @returns {boolean} - Whether the CLI is globally installed
 */
export async function isGlobalInstallation(): Promise<boolean> {
  const envInfo = await UserEnvironment.getInstanceInfo();
  return envInfo.packageManager.global;
}

/**
 * Check if we're running via npx
 * @returns {boolean} - Whether we're running through npx
 */
export async function isRunningViaNpx(): Promise<boolean> {
  const envInfo = await UserEnvironment.getInstanceInfo();
  return envInfo.packageManager.isNpx;
}

/**
 * Check if we're running via bunx
 * @returns {boolean} - Whether we're running through bunx
 */
export async function isRunningViaBunx(): Promise<boolean> {
  const envInfo = await UserEnvironment.getInstanceInfo();
  return envInfo.packageManager.isBunx;
}

/**
 * Get the install command for the specified package manager
 * @param {string} packageManager - The package manager to use
 * @param {boolean} isGlobal - Whether to install globally
 * @returns {string[]} - The install command array
 */
export function getInstallCommand(packageManager: string, isGlobal: boolean): string[] {
  if (packageManager === 'npm') {
    return ['install', ...(isGlobal ? ['-g'] : [])];
  } else {
    // bun
    return ['add', ...(isGlobal ? ['-g'] : [])];
  }
}

/**
 * Installs a package using the appropriate package manager, attempting multiple strategies if necessary.
 *
 * Tries to install the specified package from the npm registry, GitHub repositories, or a monorepo, based on the provided options and available sources. Handles normalization of plugin package names and supports version or tag specification.
 *
 * @param packageName - The name of the package to install. Can be a scoped package, organization/repo, or plugin name.
 * @param versionOrTag - Optional version or tag to install. If omitted, installs the latest version.
 * @param directory - The directory in which to run the installation.
 * @param options - Optional settings to control which installation strategies to attempt and monorepo details.
 * @returns A promise resolving to an object indicating whether installation succeeded and the installed package identifier, or null if all methods failed.
 */
export async function executeInstallation(
  packageName: string,
  versionOrTag: string = '',
  directory: string = process.cwd(),
  options: {
    tryNpm?: boolean;
    tryGithub?: boolean;
    tryMonorepo?: boolean;
    subdirectory?: string;
    monorepoBranch?: string;
  } = { tryNpm: true, tryGithub: true, tryMonorepo: false }
): Promise<{ success: boolean; installedIdentifier: string | null }> {
  // Determine which package manager to use
  const packageManager = await getPackageManager();
  const installCommand = getInstallCommand(packageManager, false);

  logger.info(`Attempting to install package: ${packageName} using ${packageManager}`);

  // Determine the package name to use for installation
  let npmStylePackageName = packageName;
  let pluginName = packageName;

  // Only transform non-scoped packages
  if (!packageName.startsWith('@')) {
    // Handle organization/repo format (e.g., 'elizaos/plugin-name')
    const parts = packageName.includes('/') ? packageName.split('/') : [null, packageName];
    const baseName = parts[parts.length - 1].replace(/^plugin-/, '');

    // Special case: CLI and core packages
    if (baseName === 'cli' || baseName === 'core') {
      npmStylePackageName = `@elizaos/${baseName}`;
      pluginName = baseName;
    } else {
      // Regular ElizaOS plugins
      pluginName = `plugin-${baseName}`;
      npmStylePackageName = `@elizaos/${pluginName}`;
    }
  }

  // 1. Try npm registry (if enabled)
  if (options.tryNpm !== false) {
    // Format the package name with version
    const packageWithVersion = versionOrTag
      ? `${npmStylePackageName}${
          versionOrTag.startsWith('@') || versionOrTag.startsWith('#')
            ? versionOrTag
            : `@${versionOrTag}`
        }`
      : npmStylePackageName;

    logger.debug(
      `Installing ${packageWithVersion} from npm registry using ${packageManager} in ${directory}`
    );

    try {
      await execa(packageManager, [...installCommand, packageWithVersion], {
        cwd: directory,
        stdio: 'inherit',
      });
      logger.info(`Successfully installed ${npmStylePackageName} from npm registry.`);
      return { success: true, installedIdentifier: npmStylePackageName };
    } catch (error) {
      logger.warn(`Failed to install from npm registry: ${npmStylePackageName}`);
      // Continue to next installation method
    }
  }

  // 2. Try GitHub URL installation (if enabled)
  if (options.tryGithub !== false) {
    // Define GitHub organizations to try, in priority order
    const githubOrgs = ['elizaos', 'elizaos-plugins'];

    // Try each GitHub organization with git+https format
    for (const org of githubOrgs) {
      const gitUrl = `git+https://github.com/${org}/${pluginName}.git${versionOrTag || ''}`;

      logger.debug(`Installing from GitHub using git+https format: ${gitUrl}`);

      try {
        await execa(packageManager, [...installCommand, gitUrl], {
          cwd: directory,
          stdio: 'inherit',
        });
        logger.info(`Successfully installed ${pluginName} from GitHub ${org}.`);
        // For verification, we'll use the standard npm package name structure
        return { success: true, installedIdentifier: npmStylePackageName };
      } catch (error) {
        logger.warn(`Failed to install from GitHub ${org} organization: ${gitUrl}`);
        // Continue to next organization or method
      }
    }
  }

  // 3. Try monorepo approach (if enabled)
  if (options.tryMonorepo !== false) {
    const branch = options.monorepoBranch || 'v2-develop';
    const subdirectory = options.subdirectory || `packages/${pluginName}`;
    const monorepoUrl = `git+https://github.com/elizaos/eliza.git#${branch}&subdirectory=${subdirectory}`;

    logger.debug(`Installing from monorepo subdirectory: ${monorepoUrl}`);

    try {
      await execa(packageManager, [...installCommand, monorepoUrl], {
        cwd: directory,
        stdio: 'inherit',
      });
      logger.info(`Successfully installed ${pluginName} from monorepo.`);
      // For verification, we'll use the standard npm package name structure
      return { success: true, installedIdentifier: npmStylePackageName };
    } catch (error) {
      logger.warn(`Failed to install from monorepo: ${monorepoUrl}`);
      // Continue to last resort
    }
  }

  // If we reached here, all preferred methods failed.
  logger.error('All installation methods (npm, GitHub, monorepo) failed.');
  return { success: false, installedIdentifier: null };
}
