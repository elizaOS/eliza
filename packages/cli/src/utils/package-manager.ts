import { logger } from '@elizaos/core';
import { UserEnvironment } from './user-environment';
import { displayBunInstallationTipCompact } from './bun-installation-helper';
import { runBunCommand } from './run-bun';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { bunExec } from './bun-exec';

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
 * Removes a package from bun.lock file to prevent circular dependency issues
 * @param packageName - The package name to remove from lockfile
 * @param directory - The directory containing the bun.lock file
 */
export async function removeFromBunLock(packageName: string, directory: string): Promise<void> {
  const lockFilePath = path.join(directory, 'bun.lock');

  if (!existsSync(lockFilePath)) {
    logger.debug(`No bun.lock file found at ${lockFilePath}, skipping removal`);
    return;
  }

  try {
    // Use bun remove to cleanly remove the package from lockfile
    const result = await bunExec('bun', ['remove', packageName], {
      cwd: directory,
    });

    if (result.success) {
      logger.debug(`Successfully removed ${packageName} from bun.lock`);
    } else {
      // Check stderr for specific error messages
      if (result.stderr?.includes('not found') || result.stderr?.includes('No such package')) {
        logger.debug(`Package ${packageName} not found in lockfile (expected for cleanup)`);
      } else {
        logger.warn(
          `Failed to remove ${packageName} from bun.lock: ${result.stderr || 'Unknown error'}`
        );
      }
    }
  } catch (error: any) {
    // Handle unexpected errors (e.g., bunExec itself throwing)
    logger.warn(`Unexpected error removing ${packageName} from bun.lock: ${error.message}`);
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
  const installCommand = getInstallCommand(false);

  const finalSpecifier = packageName.startsWith('github:')
    ? `${packageName}${versionOrTag ? `#${versionOrTag}` : ''}`
    : versionOrTag
      ? `${packageName}@${versionOrTag}`
      : packageName;

  try {
    const args = [...installCommand, finalSpecifier];
    // Run silently to suppress bun's timestamped output
    await runBunCommand(args, directory, true);

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
      logger.warn(
        `Installation failed - bun command not found. ${displayBunInstallationTipCompact()}`
      );
    } else {
      logger.warn(`Installation failed for ${finalSpecifier}: ${error.message}`);
    }
    return { success: false, installedIdentifier: null };
  }
}

/**
 * Builds a GitHub specifier string for package installation.
 *
 * @param githubSpec - The GitHub specifier (e.g., "github:owner/repo")
 * @param versionOrTag - Optional version or tag to append
 * @returns The complete GitHub specifier string
 */
export function buildGitHubSpecifier(githubSpec: string, versionOrTag?: string): string {
  if (!versionOrTag) {
    return githubSpec;
  }

  // If the spec already has a fragment (#), replace it
  const baseSpec = githubSpec.split('#')[0];
  return `${baseSpec}#${versionOrTag}`;
}

/**
 * Enhanced installation function that supports GitHub fallback with lockfile cleanup.
 *
 * @param packageName - The name of the package to install
 * @param versionOrTag - Optional version or tag to install
 * @param directory - The directory in which to run the installation
 * @param githubFallback - Optional GitHub repository path for fallback (e.g., "owner/repo")
 * @returns A promise resolving to an object indicating success and installed identifier
 */
export async function executeInstallationWithFallback(
  packageName: string,
  versionOrTag = '',
  directory: string = process.cwd(),
  githubFallback?: string
): Promise<{ success: boolean; installedIdentifier: string | null }> {
  // First try normal installation
  const result = await executeInstallation(packageName, versionOrTag, directory);

  if (result.success || !githubFallback) {
    return result;
  }

  // If npm installation failed and we have a GitHub fallback, try GitHub installation
  logger.debug(`npm installation failed, attempting GitHub fallback: ${githubFallback}`);

  // Remove package from lockfile to prevent circular dependencies
  await removeFromBunLock(packageName, directory);

  // Try GitHub installation
  const githubSpecifier = `github:${githubFallback}${versionOrTag ? `#${versionOrTag}` : ''}`;
  return await executeInstallation(githubSpecifier, '', directory);
}
