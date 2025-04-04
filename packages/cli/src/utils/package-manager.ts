import path from 'node:path';
import process from 'node:process';

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
