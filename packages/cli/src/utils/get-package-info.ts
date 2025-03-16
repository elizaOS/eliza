import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { logger } from '@elizaos/core';
import { execa } from 'execa';
import fs_extra from 'fs-extra';
import type { PackageJson } from 'type-fest';

const packageJsonPath = path.join('package.json');

/**
 * Get the current version of a package from the monorepo
 */
/**
 * Retrieves the version of a specified package.
 *
 * @param {string} packageName - The name of the package to retrieve the version for.
 * @returns {Promise<string>} A promise that resolves with the version of the package.
 */
export async function getPackageVersion(packageName: string): Promise<string> {
  try {
    // Try to find the package in the monorepo first
    const monoRepoPackagePath = path.resolve(
      process.cwd(),
      '..',
      '..',
      'packages',
      packageName.replace('@elizaos/', ''),
      'package.json'
    );

    if (existsSync(monoRepoPackagePath)) {
      const packageJson = JSON.parse(await fs.readFile(monoRepoPackagePath, 'utf8'));
      if (packageJson.version) {
        return packageJson.version;
      }
    }

    // If not in monorepo, check the CLI package dependencies
    const cliPackagePath = path.resolve(__dirname, '..', '..', 'package.json');

    if (existsSync(cliPackagePath)) {
      const packageJson = JSON.parse(await fs.readFile(cliPackagePath, 'utf8'));
      if (packageJson.dependencies?.[packageName]) {
        return packageJson.dependencies[packageName].replace('^', '');
      }
    }

    // Try to get the latest version from npm
    try {
      const { stdout } = await execa('npm', ['view', packageName, 'version']);
      if (stdout?.trim()) {
        logger.info(`Found latest version of ${packageName} from npm: ${stdout.trim()}`);
        return stdout.trim();
      }
    } catch (npmError) {
      logger.warn(`Could not get latest version from npm: ${npmError.message}`);
    }

    // Default version as fallback
    return '0.25.9';
  } catch (error) {
    logger.warn(`Error getting package version for ${packageName}: ${error}`);

    // Try to get the latest version from npm as a last resort
    try {
      const { stdout } = await execa('npm', ['view', packageName, 'version']);
      if (stdout?.trim()) {
        logger.info(`Found latest version of ${packageName} from npm: ${stdout.trim()}`);
        return stdout.trim();
      }
    } catch (npmError) {
      logger.warn(`Could not get latest version from npm: ${npmError.message}`);
    }

    // Ultimate fallback
    return '0.25.9';
  }
}

/**
 * Check if we're inside a monorepo
 */
export function isMonorepoContext(): boolean {
  // Check for tell-tale signs of being in the monorepo
  const possibleMonorepoRoot = path.resolve(process.cwd(), '..', '..');
  const workspacePackageJsonPath = path.join(possibleMonorepoRoot, 'package.json');

  if (existsSync(workspacePackageJsonPath)) {
    try {
      const packageJson = JSON.parse(readFileSync(workspacePackageJsonPath, 'utf8'));
      return !!packageJson.workspaces;
    } catch (_error) {
      return false;
    }
  }

  return false;
}

/**
 * Get local packages available in the monorepo
 */
export async function getLocalPackages(): Promise<string[]> {
  if (!isMonorepoContext()) {
    return [];
  }

  try {
    const packagesDir = path.resolve(process.cwd(), '..', '..');
    const packagesDirEntries = await fs.readdir(path.join(packagesDir, 'packages'), {
      withFileTypes: true,
    });

    const pluginPackages = packagesDirEntries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('plugin-'))
      .map((entry) => `@elizaos/${entry.name}`);

    return pluginPackages;
  } catch (error) {
    logger.warn(`Error getting local packages: ${error}`);
    return [];
  }
}

export function getPackageInfo() {
  return fs_extra.readJSONSync(packageJsonPath) as PackageJson;
}
