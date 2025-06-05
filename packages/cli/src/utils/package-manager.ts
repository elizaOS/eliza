import { logger } from '@elizaos/core';
import { execa } from 'execa';
import { UserEnvironment } from './user-environment';
import { displayBunInstallationTipCompact } from './bun-installation-helper';

/**
 * Always returns 'bun' as the package manager for ElizaOS CLI.
 *
 * @returns A promise that resolves to 'bun'.
 */
export async function getPackageManager(): Promise<string> {
  logger.debug('[PackageManager] Using bun as the package manager for ElizaOS CLI');
  return 'bun';
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
 * Get the install command for bun
 * @param {boolean} isGlobal - Whether to install globally
 * @returns {string[]} - The bun install command array
 */
export function getInstallCommand(isGlobal: boolean): string[] {
  return ['add', ...(isGlobal ? ['-g'] : [])];
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
  const installCommand = getInstallCommand(false);

  logger.debug(`Attempting to install package: ${packageName} using bun`);

  const finalSpecifier = packageName.startsWith('github:')
    ? `${packageName}${versionOrTag ? `#${versionOrTag}` : ''}`
    : versionOrTag
      ? `${packageName}@${versionOrTag}`
      : packageName;
  try {
    await execa('bun', [...installCommand, finalSpecifier], {
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
  } catch (error: any) {
    // Check if it's a bun not found error
    if (error.code === 'ENOENT' || error.message?.includes('bun: command not found')) {
      logger.warn(`Installation failed - bun command not found. ${displayBunInstallationTipCompact()}`);
    } else {
      logger.warn(`Installation failed for ${finalSpecifier}: ${error.message}`);
    }
    return { success: false, installedIdentifier: null };
  }
}
