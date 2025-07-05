import { logger } from '@elizaos/core';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
// Glob is used only for Windows pnpm fallback strategy
import { glob } from 'glob';
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
 * Ensures path is normalized for cross-platform compatibility
 */
function resolveNodeModulesPath(repository: string, ...segments: string[]): string {
  return path.normalize(path.resolve(process.cwd(), 'node_modules', repository, ...segments));
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
  {
    name: 'pnpm windows fallback',
    tryImport: async (repository: string) => {
      // Only apply this strategy on Windows
      if (process.platform !== 'win32') return null;
      
      // For pnpm on Windows, the package might be in .pnpm directory with a different structure
      // We need to try both standard package name format and the scope+name format used by pnpm
      let pnpmPath;
      
      // Handle scoped packages (@namespace/package)
      if (repository.includes('/')) {
        const [scope, name] = repository.split('/');
        // pnpm uses + instead of / in directory names
        const pnpmPackageDir = `${scope.substring(1)}+${name}`;
        pnpmPath = path.normalize(path.resolve(
          process.cwd(),
          'node_modules',
          '.pnpm',
          `${pnpmPackageDir}@*`,
          'node_modules',
          repository
        ));
      } else {
        // For non-scoped packages
        pnpmPath = path.normalize(path.resolve(
          process.cwd(),
          'node_modules',
          '.pnpm',
          `${repository}@*`,
          'node_modules',
          repository
        ));
      }
      
      // First try with the exact path
      if (existsSync(pnpmPath)) {
        return tryImporting(pnpmPath, 'pnpm windows fallback (exact)', repository);
      }
      
      // If exact path doesn't exist, try to find a matching directory with glob pattern
      try {
        const basePath = path.normalize(path.resolve(process.cwd(), 'node_modules', '.pnpm'));
        
        if (existsSync(basePath)) {
          let pattern;
          if (repository.includes('/')) {
            const [scope, name] = repository.split('/');
            pattern = `${basePath}/${scope.substring(1)}+${name}@*`;
          } else {
            pattern = `${basePath}/${repository}@*`;
          }
          
          // Use the synchronous version of glob
          const matches = glob.sync(pattern);
          
          for (const match of matches) {
            const fullPath = path.normalize(path.join(match, 'node_modules', repository));
            if (existsSync(fullPath)) {
              return tryImporting(fullPath, 'pnpm windows fallback (glob)', repository);
            }
          }
        }
      } catch (error) {
        logger.debug(`Failed to use glob pattern for pnpm windows fallback:`, error);
      }
      
      return null;
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
