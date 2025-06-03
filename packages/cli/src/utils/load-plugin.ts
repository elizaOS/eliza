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
  repository: string
): Promise<any | null> {
  try {
    const module = await import(importPath);
    logger.success(`Successfully loaded plugin '${repository}' using ${strategy} (${importPath})`);
    return module;
  } catch (error) {
    logger.debug(`Import failed using ${strategy} ('${importPath}'):`, error);
    return null;
  }
}

/**
 * Collection of import strategies
 */
const importStrategies: ImportStrategy[] = [
  {
    name: 'direct path',
    tryImport: async (repository: string) => tryImporting(repository, 'direct path', repository),
  },
  {
    name: 'local node_modules',
    tryImport: async (repository: string) =>
      tryImporting(resolveNodeModulesPath(repository), 'local node_modules', repository),
  },
  {
    name: 'global node_modules',
    tryImport: async (repository: string) => {
      const globalPath = path.resolve(getGlobalNodeModulesPath(), repository);
      if (!fs.existsSync(path.dirname(globalPath))) {
        logger.debug(
          `Global node_modules directory not found at ${path.dirname(globalPath)}, skipping for ${repository}`
        );
        return null;
      }
      return tryImporting(globalPath, 'global node_modules', repository);
    },
  },
  {
    name: 'package.json entry',
    tryImport: async (repository: string) => {
      const packageJson = await readPackageJson(repository);
      if (!packageJson) return null;

      const entryPoint = packageJson.module || packageJson.main || DEFAULT_ENTRY_POINT;
      return tryImporting(
        resolveNodeModulesPath(repository, entryPoint),
        `package.json entry (${entryPoint})`,
        repository
      );
    },
  },
  {
    name: 'common dist pattern',
    tryImport: async (repository: string) => {
      const packageJson = await readPackageJson(repository);
      if (packageJson?.main === DEFAULT_ENTRY_POINT) return null;

      return tryImporting(
        resolveNodeModulesPath(repository, DEFAULT_ENTRY_POINT),
        'common dist pattern',
        repository
      );
    },
  },
];

/**
 * Attempts to load a plugin module using various strategies.
 * It tries direct import, local node_modules, global node_modules,
 * package.json entry points, and common dist patterns.
 *
 * @param repository - The plugin repository/package name to load.
 * @returns The loaded plugin module or null if loading fails after all attempts.
 */
export async function loadPluginModule(repository: string): Promise<any | null> {
  //logger.debug(`Attempting to load plugin module: ${repository}`);

  for (const strategy of importStrategies) {
    const result = await strategy.tryImport(repository);
    if (result) return result;
  }

  logger.warn(`Failed to load plugin module '${repository}' using all available strategies.`);
  return null;
}
