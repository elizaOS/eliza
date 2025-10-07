import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '@elizaos/core';
import { bunExec } from './bun-exec';
import { runBunWithSpinner } from './spinner-utils';
import { detectDirectoryType } from './directory-detection';

/**
 * Dependency management utilities for ElizaOS CLI
 */

interface BunExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

/**
 * Check if @elizaos/cli is present in package.json dependencies or devDependencies
 */
export function hasElizaOSCli(packageJsonPath: string): boolean {
  try {
    if (!fs.existsSync(packageJsonPath)) {
      return false;
    }

    let packageJson: PackageJson;
    try {
      packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    } catch (parseError) {
      logger.debug({ error: parseError, packageJsonPath }, `Error parsing JSON in package.json`);
      return false;
    }

    const dependencies = packageJson.dependencies || {};
    const devDependencies = packageJson.devDependencies || {};

    return '@elizaos/cli' in dependencies || '@elizaos/cli' in devDependencies;
  } catch (error) {
    logger.debug({ error, packageJsonPath }, `Error reading package.json`);
    return false;
  }
}

/**
 * Check if we should auto-install @elizaos/cli
 * Returns true if:
 * - Not in a monorepo
 * - Has package.json
 * - @elizaos/cli is not already present
 * - Auto-install is not disabled
 */
export function shouldAutoInstallCli(cwd: string = process.cwd()): boolean {
  // Check if auto-install is disabled
  if (process.env.ELIZA_NO_AUTO_INSTALL === 'true') {
    logger.debug('Auto-install disabled via ELIZA_NO_AUTO_INSTALL');
    return false;
  }

  // Skip in test or CI environments
  if (process.env.CI === 'true' || process.env.ELIZA_TEST_MODE === 'true') {
    logger.debug('Skipping auto-install in CI/test environment');
    return false;
  }

  // Detect directory type
  const dirInfo = detectDirectoryType(cwd);

  // Don't install if we're in a monorepo (it should already have the CLI)
  if (dirInfo.type === 'elizaos-monorepo' || dirInfo.monorepoRoot) {
    logger.debug('Skipping auto-install in monorepo');
    return false;
  }

  // Need package.json to install dependencies
  if (!dirInfo.hasPackageJson) {
    logger.debug('No package.json found, skipping auto-install');
    return false;
  }

  // Check if @elizaos/cli is already present
  const packageJsonPath = path.join(cwd, 'package.json');
  if (hasElizaOSCli(packageJsonPath)) {
    logger.debug('@elizaos/cli already present, skipping auto-install');
    return false;
  }

  return true;
}

/**
 * Install @elizaos/cli as a dev dependency using bun
 */
export async function installElizaOSCli(cwd: string = process.cwd()): Promise<boolean> {
  try {
    logger.info('Adding @elizaos/cli as dev dependency for enhanced development experience...');

    const result = await runBunWithSpinner(['add', '--dev', '@elizaos/cli'], cwd, {
      spinnerText: 'Installing @elizaos/cli with bun...',
      successText: '✓ @elizaos/cli installed successfully',
      errorText: 'Failed to install @elizaos/cli',
      showOutputOnError: false, // Don't show verbose output for this
    });

    if (result.success) {
      logger.info('✓ @elizaos/cli added as dev dependency');
      return true;
    } else {
      logger.warn('⚠ Failed to install @elizaos/cli as dev dependency (optional)');
      logger.debug({ error: result.error }, 'Installation error:');
      return false;
    }
  } catch (error) {
    logger.warn('⚠ Failed to install @elizaos/cli as dev dependency (optional)');
    logger.debug({ error }, 'Installation error:');
    return false;
  }
}

/**
 * Auto-install @elizaos/cli if conditions are met
 * This is the main function that should be called from start/dev commands
 * Uses bun as the package manager (ElizaOS standard)
 */
export async function ensureElizaOSCli(cwd: string = process.cwd()): Promise<void> {
  // Quick check if we should proceed
  if (!shouldAutoInstallCli(cwd)) {
    return;
  }

  logger.debug('Auto-installing @elizaos/cli for enhanced development experience');

  // Attempt to install using bun
  const success = await installElizaOSCli(cwd);

  if (success) {
    logger.info('Next time you can use the local CLI for better performance and consistency');
  }
}

/**
 * Get the version of @elizaos/cli that would be installed
 * This is useful for showing the user what version will be added
 */
export async function getLatestElizaOSCliVersion(): Promise<string | null> {
  try {
    const result: BunExecResult = await bunExec('bun', ['info', '@elizaos/cli', '--json'], {
      stdio: 'pipe',
    });

    if (result.success && result.stdout) {
      try {
        const info = JSON.parse(result.stdout);
        return info.version || info.dist?.version || 'latest';
      } catch (parseError) {
        logger.debug({ error: parseError }, 'Error parsing JSON from bun info command:');
        return null;
      }
    }

    return null;
  } catch (error) {
    logger.debug({ error }, 'Error getting @elizaos/cli version with bun:');
    return null;
  }
}

/**
 * Check if the current directory already has ElizaOS dependencies
 * This helps determine if auto-installing the CLI makes sense
 */
export function hasElizaOSDependencies(cwd: string = process.cwd()): boolean {
  const dirInfo = detectDirectoryType(cwd);
  return dirInfo.hasElizaOSDependencies && dirInfo.elizaPackageCount > 0;
}

/**
 * Create a package.json if it doesn't exist (for standalone usage)
 * This is a fallback for cases where someone wants to use elizaos in a new directory
 * Uses bun as the package manager
 */
export async function ensurePackageJson(cwd: string = process.cwd()): Promise<boolean> {
  const packageJsonPath = path.join(cwd, 'package.json');

  if (fs.existsSync(packageJsonPath)) {
    return true;
  }

  try {
    // Validate and sanitize directory name for package name
    const rawDirName = path.basename(cwd);
    const sanitizedName = rawDirName
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-') // Replace invalid chars with hyphens
      .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
      .replace(/-+/g, '-'); // Collapse multiple hyphens

    const packageName = sanitizedName || 'eliza-project';

    // Create a minimal package.json optimized for bun
    const minimal = {
      name: packageName,
      version: '1.0.0',
      type: 'module',
      scripts: {
        start: 'elizaos start',
        dev: 'elizaos dev',
      },
    };

    fs.writeFileSync(packageJsonPath, JSON.stringify(minimal, null, 2));
    logger.info('Created package.json for ElizaOS project (bun ready)');
    return true;
  } catch (error) {
    logger.warn(
      'Could not create package.json:',
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}
