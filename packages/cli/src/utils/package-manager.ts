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
  versionOrTag = '',
  directory: string = process.cwd()
): Promise<{ success: boolean; installedIdentifier: string | null }> {
  const packageManager = await getPackageManager();
  const installCommand = getInstallCommand(packageManager, false);

  logger.debug(`Attempting to install package: ${packageName} using ${packageManager}`);

  const finalSpecifier = packageName.startsWith('github:')
    ? `${packageName}${versionOrTag ? `#${versionOrTag}` : ''}`
    : versionOrTag
      ? `${packageName}@${versionOrTag}`
      : packageName;
  try {
    await execa(packageManager, [...installCommand, finalSpecifier], {
      cwd: directory,
      stdio: 'inherit',
    });
    logger.debug(`Successfully installed ${finalSpecifier}.`);

    const installedIdentifier = packageName.startsWith('github:')
      ? (() => {
          const spec = packageName.replace(/^github:/, '');
          const [owner, repoWithRef] = spec.split('/');
          const repo = repoWithRef.split('#')[0];
          return `@${owner}/${repo}`;
        })()
      : packageName;

    return { success: true, installedIdentifier };
  } catch (error) {
    logger.warn(`Installation failed for ${finalSpecifier}: ${error.message}`);
    return { success: false, installedIdentifier: null };
  }
}
