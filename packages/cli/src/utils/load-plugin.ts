import { logger } from '@elizaos/core';
import fs from 'node:fs';
import path from 'node:path';

interface PackageJson {
  module?: string;
  main?: string;
}

interface ImportStrategy {
  name: string;
  tryImport: (repository: string) => Promise<any | null>;
}

const DEFAULT_ENTRY_POINT = 'dist/index.js';

/**
 * Get the global node_modules path based on Node.js installation
 */
function getGlobalNodeModulesPath(): string {
  // process.execPath gives us the path to the node executable
  const nodeDir = path.dirname(process.execPath);

  if (process.platform === 'win32') {
    // On Windows, node_modules is typically in the same directory as node.exe
    return path.join(nodeDir, 'node_modules');
  } else {
    // On Unix systems, we go up one level from bin directory
    return path.join(nodeDir, '..', 'lib', 'node_modules');
  }
}

/**
 * Helper function to resolve a path within node_modules
 */
function resolveNodeModulesPath(repository: string, ...segments: string[]): string {
  return path.resolve(process.cwd(), 'node_modules', repository, ...segments);
}

/**
 * Helper function to read and parse package.json
 */
async function readPackageJson(repository: string): Promise<PackageJson | null> {
  const packageJsonPath = resolveNodeModulesPath(repository, 'package.json');
  try {
    if (fs.existsSync(packageJsonPath)) {
      return JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    }
  } catch (error) {
    logger.debug(`Failed to read package.json for '${repository}':`, error);
  }
  return null;
}

/**
 * Attempts to import a module from a given path and logs the outcome.
 */
async function tryImporting(
  importPath: string,
  strategy: string,
  repository: string,
  silentFailure = false
): Promise<any | null> {
  try {
    const module = await import(importPath);
    logger.success(`Successfully loaded plugin '${repository}' using ${strategy} (${importPath})`);
    return module;
  } catch (error) {
    if (!silentFailure) {
      logger.debug(`Import failed using ${strategy} ('${importPath}'):`, error);
    }
    return null;
  }
}

/**
 * Collection of import strategies
 */
const importStrategies: ImportStrategy[] = [
  // Most likely to succeed for installed packages - check package.json entry first
  {
    name: 'package.json entry',
    tryImport: async (repository: string) => {
      const packageJson = await readPackageJson(repository);
      if (!packageJson) return null;

      const entryPoint = packageJson.module || packageJson.main || DEFAULT_ENTRY_POINT;
      return tryImporting(
        resolveNodeModulesPath(repository, entryPoint),
        `package.json entry (${entryPoint})`,
        repository,
        true
      );
    },
  },
  // Second most common - standard dist/index.js pattern
  {
    name: 'common dist pattern',
    tryImport: async (repository: string) => {
      const packageJson = await readPackageJson(repository);
      if (packageJson?.main === DEFAULT_ENTRY_POINT) return null;

      return tryImporting(
        resolveNodeModulesPath(repository, DEFAULT_ENTRY_POINT),
        'common dist pattern',
        repository,
        true
      );
    },
  },
  // Try local node_modules directory import (for packages without explicit entry)
  {
    name: 'local node_modules',
    tryImport: async (repository: string) =>
      tryImporting(resolveNodeModulesPath(repository), 'local node_modules', repository, true),
  },
  // Direct path import (for relative/absolute paths)
  {
    name: 'direct path',
    tryImport: async (repository: string) =>
      tryImporting(repository, 'direct path', repository, true),
  },
  // Least likely - global node_modules (usually for globally installed packages)
  {
    name: 'global node_modules',
    tryImport: async (repository: string) => {
      const globalPath = path.resolve(getGlobalNodeModulesPath(), repository);
      if (!fs.existsSync(path.dirname(globalPath))) {
        return null;
      }
      return tryImporting(globalPath, 'global node_modules', repository, true);
    },
  },
];

/**
 * Determines the optimal import strategy based on what's available
 */
async function getOptimalStrategy(repository: string): Promise<ImportStrategy | null> {
  const packageJson = await readPackageJson(repository);

  if (packageJson) {
    const entryPoint = packageJson.module || packageJson.main || DEFAULT_ENTRY_POINT;
    const entryPath = resolveNodeModulesPath(repository, entryPoint);

    if (fs.existsSync(entryPath)) {
      return {
        name: `package.json entry (${entryPoint})`,
        tryImport: async () =>
          tryImporting(entryPath, `package.json entry (${entryPoint})`, repository),
      };
    }
  }

  const commonDistPath = resolveNodeModulesPath(repository, DEFAULT_ENTRY_POINT);
  if (fs.existsSync(commonDistPath)) {
    return {
      name: 'common dist pattern',
      tryImport: async () => tryImporting(commonDistPath, 'common dist pattern', repository),
    };
  }

  const localNodeModulesPath = resolveNodeModulesPath(repository);
  if (fs.existsSync(localNodeModulesPath)) {
    return {
      name: 'local node_modules',
      tryImport: async () => tryImporting(localNodeModulesPath, 'local node_modules', repository),
    };
  }

  return null;
}

/**
 * Attempts to load a plugin module using various strategies.
 * First tries to find the optimal path, then falls back to trying all strategies.
 *
 * @param repository - The plugin repository/package name to load.
 * @returns The loaded plugin module or null if loading fails after all attempts.
 */
export async function loadPluginModule(repository: string): Promise<any | null> {
  //logger.debug(`Attempting to load plugin module: ${repository}`);

  const optimalStrategy = await getOptimalStrategy(repository);
  if (optimalStrategy) {
    const result = await optimalStrategy.tryImport(repository);
    if (result) return result;
  }

  for (const strategy of importStrategies) {
    const result = await strategy.tryImport(repository);
    if (result) return result;
  }

  logger.warn(`Failed to load plugin module '${repository}' using all available strategies.`);
  return null;
}
