import { logger } from '@elizaos/core';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  detectPluginContext,
  ensurePluginBuilt,
  provideLocalPluginGuidance,
} from './plugin-context';

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
 * Get the global node_modules path based on Node.js/Bun installation
 */
function getGlobalNodeModulesPath(): string {
  const execDir = path.dirname(process.execPath);
  const isBun = typeof Bun !== 'undefined';

  if (process.platform === 'win32') {
    if (isBun) {
      // For Bun on Windows, check common installation paths
      const bunPaths = [
        path.join(execDir, 'node_modules'),
        path.join(process.env.APPDATA || '', 'bun', 'node_modules'),
        path.join(process.env.LOCALAPPDATA || '', 'bun', 'node_modules'),
        path.join(process.env.USERPROFILE || '', '.bun', 'node_modules'),
      ];
      
      // Return the first path that exists
      for (const potentialPath of bunPaths) {
        if (existsSync(potentialPath)) {
          return potentialPath;
        }
      }
    }
    
    // Default for Windows
    return path.join(execDir, 'node_modules');
  } else {
    // On Unix systems
    if (isBun) {
      // Check common locations for Bun on Unix
      const homeDir = process.env.HOME || '';
      const bunUnixPaths = [
        path.join(homeDir, '.bun', 'node_modules'),
        path.join(execDir, 'node_modules'),
        path.join(execDir, '..', 'lib', 'node_modules'),
      ];
      
      for (const potentialPath of bunUnixPaths) {
        if (existsSync(potentialPath)) {
          return potentialPath;
        }
      }
    }
    
    // Default for Unix
    return path.join(execDir, '..', 'lib', 'node_modules');
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
    if (existsSync(packageJsonPath)) {
      return JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
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
    // On Windows, normalize paths for Bun compatibility
    const pathToImport = process.platform === 'win32' ? importPath.replace(/\\/g, '/') : importPath;
    
    const module = await import(pathToImport);
    logger.success(`Successfully loaded plugin '${repository}' using ${strategy} (${importPath})`);
    return module;
  } catch (error: any) {
    logger.debug(`Import failed using ${strategy} ('${importPath}'):`, error);
    return null;
  }
}

/**
 * Collection of import strategies
 */
const importStrategies: ImportStrategy[] = [
  // Try local development first - this is the most important for plugin testing
  {
    name: 'local development plugin',
    tryImport: async (repository: string) => {
      const context = detectPluginContext(repository);

      if (context.isLocalDevelopment) {
        logger.debug(`Detected local development for plugin: ${repository}`);

        // Ensure the plugin is built
        const isBuilt = await ensurePluginBuilt(context);
        if (!isBuilt) {
          provideLocalPluginGuidance(repository, context);
          return null;
        }

        // Try to load from built output
        if (context.localPath && existsSync(context.localPath)) {
          logger.info(`Loading local development plugin: ${repository}`);
          return tryImporting(context.localPath, 'local development plugin', repository);
        }

        // This shouldn't happen if ensurePluginBuilt succeeded, but handle it gracefully
        logger.warn(`Plugin built but output not found at expected path: ${context.localPath}`);
        provideLocalPluginGuidance(repository, context);
        return null;
      }

      return null;
    },
  },
  // Try workspace dependencies (for monorepo packages)
  {
    name: 'workspace dependency',
    tryImport: async (repository: string) => {
      if (repository.startsWith('@elizaos/plugin-')) {
        // Try to find the plugin in the workspace
        const pluginName = repository.replace('@elizaos/', '');
        const workspacePath = path.resolve(process.cwd(), '..', pluginName, 'dist', 'index.js');
        if (existsSync(workspacePath)) {
          return tryImporting(workspacePath, 'workspace dependency', repository);
        }
      }
      return null;
    },
  },
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
      if (!existsSync(path.dirname(globalPath))) {
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

      let entryPoint = packageJson.module || packageJson.main || DEFAULT_ENTRY_POINT;
      
      // Ensure entryPoint uses normalized path separators for Windows/Bun compatibility
      if (process.platform === 'win32') {
        entryPoint = entryPoint.replace(/\\/g, '/');
      }
      
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
      
      // Use Windows-compatible default entry point path
      const entryPoint = process.platform === 'win32' ? 
        DEFAULT_ENTRY_POINT.replace(/\//g, path.sep) : 
        DEFAULT_ENTRY_POINT;

      return tryImporting(
        resolveNodeModulesPath(repository, entryPoint),
        'common dist pattern',
        repository
      );
    },
  },
];

/**
 * Determines if a package name is from the ElizaOS ecosystem
 */
function isElizaOSPackageName(repository: string): boolean {
  return repository.startsWith('@elizaos/') || repository.startsWith('@elizaos-plugins/');
}

/**
 * Get relevant import strategies based on plugin type
 */
function getStrategiesForPlugin(repository: string): ImportStrategy[] {
  const isElizaOS = isElizaOSPackageName(repository);

  if (isElizaOS) {
    // ElizaOS ecosystem plugins: try all strategies
    return importStrategies;
  } else {
    // Third-party plugins: only try relevant strategies
    return importStrategies.filter(
      (strategy) =>
        strategy.name === 'local development plugin' ||
        strategy.name === 'package.json entry' ||
        strategy.name === 'common dist pattern'
    );
  }
}

/**
 * Attempts to load a plugin module using relevant strategies based on plugin type.
 * ElizaOS ecosystem plugins (@elizaos/*) use all strategies,
 * while third-party plugins use only relevant strategies to avoid noise.
 *
 * @param repository - The plugin repository/package name to load.
 * @returns The loaded plugin module or null if loading fails after all attempts.
 */
export async function loadPluginModule(repository: string): Promise<any | null> {
  const isElizaOS = isElizaOSPackageName(repository);
  const strategies = getStrategiesForPlugin(repository);

  logger.debug(
    `Loading ${isElizaOS ? 'ElizaOS' : 'third-party'} plugin: ${repository} (${strategies.length} strategies)`
  );

  for (const strategy of strategies) {
    const result = await strategy.tryImport(repository);
    if (result) return result;
  }

  logger.warn(`Failed to load plugin module '${repository}' using all relevant strategies.`);
  return null;
}
