import path from 'node:path';
import process from 'node:process';
import { execa } from 'execa';
import type { ExecaChildProcess, ExecaReturnValue } from 'execa';
import { logger } from '@elizaos/core';

// DO NOT USE IT FOR PLUGIN INSTALLATION
/**
 * Check if the CLI is running from a global installation
 * @returns {boolean} - Whether the CLI is globally installed
 */
export function isGlobalInstallation(): boolean {
  const cliPath = process.argv[1];
  return (
    cliPath.includes('/usr/local/') ||
    cliPath.includes('/usr/bin/') ||
    process.env.NODE_ENV === 'global' ||
    process.cwd().indexOf(path.dirname(cliPath)) !== 0
  );
}

/**
 * Check if we're running via npx
 * @returns {boolean} - Whether we're running through npx
 */
export function isRunningViaNpx(): boolean {
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
export function isRunningViaBunx(): boolean {
  // Check if we're running through bunx
  return (
    process.argv[1]?.includes('bunx') ||
    process.env.BUN_INSTALL === '1' ||
    process.argv[0]?.includes('bun')
  );
}

/**
 * Determine which package manager should be used
 * @returns {string} - The package manager to use ('npm' or 'bun')
 */
export function getPackageManager(): string {
  if (isRunningViaNpx()) {
    return 'npm';
  } else if (isRunningViaBunx()) {
    return 'bun';
  }

  // Default to bun if we can't determine
  return 'bun';
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
 * Execute a package installation using the appropriate package manager and settings
 * @param {string} packageName - The package to install
 * @param {string} versionOrTag - Version or tag to install (optional)
 * @param {string} directory - Directory to install in
 * @param {Object} options - Additional installation options
 * @returns {Promise<{ success: boolean; installedIdentifier: string | null }>} - The result of the installation
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
  const packageManager = getPackageManager();
  const installCommand = getInstallCommand(packageManager, false);

  logger.info(`Attempting to install package: ${packageName} using ${packageManager}`);

  // Extract and normalize the plugin name
  let baseName = packageName;

  // Handle organization/repo format
  if (packageName.includes('/') && !packageName.startsWith('@')) {
    const parts = packageName.split('/');
    baseName = parts[parts.length - 1];
  } else if (packageName.startsWith('@')) {
    // Handle scoped package format
    const parts = packageName.split('/');
    if (parts.length > 1) {
      baseName = parts[1];
    }
  }

  // Remove plugin- prefix if present and ensure proper format
  baseName = baseName.replace(/^plugin-/, '');
  const pluginName = baseName.startsWith('plugin-') ? baseName : `plugin-${baseName}`;
  const npmStylePackageName = `@elizaos/${pluginName}`;

  // 1. Try npm registry (if enabled)
  if (options.tryNpm !== false) {
    // Format the package name with version if provided
    const packageWithVersion = versionOrTag
      ? `${npmStylePackageName}${versionOrTag.startsWith('@') || versionOrTag.startsWith('#') ? versionOrTag : `@${versionOrTag}`}`
      : npmStylePackageName;

    logger.debug(
      `Installing ${packageWithVersion} from npm registry using ${packageManager} in ${directory}`
    );

    // Try to install from npm
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
