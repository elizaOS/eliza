import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '@elizaos/core';

/**
 * Check if a package is a workspace package in the current monorepo
 */
export async function isWorkspacePackage(packageName: string): Promise<boolean> {
  try {
    // Check if we're in a monorepo by looking for workspace configuration
    const rootPackageJsonPath = path.join(process.cwd(), 'package.json');
    if (!existsSync(rootPackageJsonPath)) {
      return false;
    }

    const rootPackageJson = JSON.parse(await fs.readFile(rootPackageJsonPath, 'utf-8'));

    // Check for npm/yarn/pnpm workspaces
    if (!rootPackageJson.workspaces && !rootPackageJson.pnpm?.workspace) {
      // Not a workspace-enabled project
      return false;
    }

    // Extract package name without scope
    const simpleName = packageName.replace(/^@[^/]+\//, '');

    // Check common workspace locations
    const possiblePaths = [
      path.join(process.cwd(), 'packages', simpleName),
      path.join(process.cwd(), 'packages', simpleName.replace('plugin-', '')),
      path.join(process.cwd(), 'plugins', simpleName),
      path.join(process.cwd(), 'plugins', simpleName.replace('plugin-', '')),
    ];

    for (const possiblePath of possiblePaths) {
      if (existsSync(path.join(possiblePath, 'package.json'))) {
        const pkgJson = JSON.parse(
          await fs.readFile(path.join(possiblePath, 'package.json'), 'utf-8')
        );
        if (pkgJson.name === packageName) {
          return true;
        }
      }
    }

    return false;
  } catch (error) {
    logger.debug(
      `Error checking workspace package: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Get the local path for a workspace package
 */
export async function getWorkspacePackagePath(packageName: string): Promise<string | null> {
  try {
    const simpleName = packageName.replace(/^@[^/]+\//, '');

    const possiblePaths = [
      path.join(process.cwd(), 'packages', simpleName),
      path.join(process.cwd(), 'packages', simpleName.replace('plugin-', '')),
      path.join(process.cwd(), 'plugins', simpleName),
      path.join(process.cwd(), 'plugins', simpleName.replace('plugin-', '')),
    ];

    for (const possiblePath of possiblePaths) {
      if (existsSync(path.join(possiblePath, 'package.json'))) {
        const pkgJson = JSON.parse(
          await fs.readFile(path.join(possiblePath, 'package.json'), 'utf-8')
        );
        if (pkgJson.name === packageName) {
          return possiblePath;
        }
      }
    }

    return null;
  } catch (error) {
    logger.debug(
      `Error getting workspace package path: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Get all available workspace packages
 */
export async function getAvailableWorkspacePackages(): Promise<string[]> {
  try {
    const packages: string[] = [];
    const packagesDir = path.join(process.cwd(), 'packages');

    if (!existsSync(packagesDir)) {
      return packages;
    }

    const entries = await fs.readdir(packagesDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const packageJsonPath = path.join(packagesDir, entry.name, 'package.json');
        if (existsSync(packageJsonPath)) {
          try {
            const pkgJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
            if (pkgJson.name && pkgJson.name.includes('plugin')) {
              packages.push(pkgJson.name);
            }
          } catch {
            // Ignore invalid package.json files
          }
        }
      }
    }

    return packages;
  } catch (error) {
    logger.debug(
      `Error getting workspace packages: ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
}

/**
 * Check if we're in a monorepo root
 */
export function isMonorepoRoot(): boolean {
  try {
    const rootPackageJsonPath = path.join(process.cwd(), 'package.json');
    if (!existsSync(rootPackageJsonPath)) {
      return false;
    }

    const rootPackageJson = JSON.parse(require('fs').readFileSync(rootPackageJsonPath, 'utf-8'));

    // Check for workspace configuration
    return !!(rootPackageJson.workspaces || rootPackageJson.pnpm?.workspace);
  } catch {
    return false;
  }
}
