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
 * Find the monorepo root directory by looking for a package.json with workspaces
 */
function findMonorepoRoot(): string | null {
  try {
    let currentDir = process.cwd();
    const visited = new Set<string>();

    while (!visited.has(currentDir)) {
      visited.add(currentDir);
      const pkgPath = path.join(currentDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.workspaces) {
          return currentDir;
        }
      }
      const parent = path.dirname(currentDir);
      if (parent === currentDir) break; // Reached root
      currentDir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get all workspace packages in the monorepo
 */
function getWorkspacePackages(): Map<string, string> {
  const workspacePackages = new Map<string, string>();
  const monorepoRoot = findMonorepoRoot();

  if (!monorepoRoot) {
    return workspacePackages;
  }

  try {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(monorepoRoot, 'package.json'), 'utf8'));
    const workspaces = rootPkg.workspaces || [];

    for (const workspace of workspaces) {
      const workspacePattern = workspace.replace('/*', '');
      const packagesDir = path.join(monorepoRoot, workspacePattern);

      if (fs.existsSync(packagesDir) && fs.statSync(packagesDir).isDirectory()) {
        const dirs = fs.readdirSync(packagesDir);

        for (const dir of dirs) {
          const pkgPath = path.join(packagesDir, dir, 'package.json');
          if (fs.existsSync(pkgPath)) {
            try {
              const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
              if (pkg.name) {
                workspacePackages.set(pkg.name, path.join(packagesDir, dir));
              }
            } catch (error) {
              logger.debug(`Failed to parse package.json at ${pkgPath}:`, error);
            }
          }
        }
      }
    }
  } catch (error) {
    logger.debug('Failed to get workspace packages:', error);
  }

  return workspacePackages;
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
    const module = await import(importPath);
    logger.success(`Successfully loaded plugin '${repository}' using ${strategy} (${importPath})`);
    return module;
  } catch (error) {
    logger.debug(`Import failed using ${strategy} ('${importPath}'):`, error);
    return null;
  }
}

/**
 * Collection of import strategies in cascading order:
 * 1. Workspace packages (if in monorepo)
 * 2. Local node_modules of current workspace
 * 3. Plugin registry (handled in install flow)
 * 4. Global node_modules
 * 5. NPM (handled in install flow)
 * 6. GitHub fallback (handled in install flow)
 */
const importStrategies: ImportStrategy[] = [
  // 1. Check workspace packages FIRST (if in monorepo)
  {
    name: 'workspace package',
    tryImport: async (repository: string) => {
      const workspacePackages = getWorkspacePackages();

      logger.debug(
        `[Workspace Loader] Looking for ${repository}. Found ${workspacePackages.size} workspace packages`
      );

      if (workspacePackages.has(repository)) {
        const packagePath = workspacePackages.get(repository)!;
        const pkgJsonPath = path.join(packagePath, 'package.json');

        if (fs.existsSync(pkgJsonPath)) {
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
          const entryPoint = pkgJson.module || pkgJson.main || DEFAULT_ENTRY_POINT;
          const fullPath = path.join(packagePath, entryPoint);

          if (fs.existsSync(fullPath)) {
            return tryImporting(fullPath, 'workspace package', repository);
          } else {
            logger.debug(
              `Workspace package ${repository} found but entry point not built: ${fullPath}`
            );

            // Check if source exists but not built
            const srcPath = path.join(packagePath, 'src', 'index.ts');
            if (fs.existsSync(srcPath)) {
              logger.warn(
                `Workspace plugin ${repository} found but not built. Please run 'bun run build' in ${packagePath}`
              );
            }
          }
        }
      }
      return null;
    },
  },
  // 2. Check local node_modules (includes locally installed packages)
  {
    name: 'local node_modules',
    tryImport: async (repository: string) => {
      // First try with package.json entry point
      const packageJson = await readPackageJson(repository);
      if (packageJson) {
        const entryPoint = packageJson.module || packageJson.main || DEFAULT_ENTRY_POINT;
        const result = await tryImporting(
          resolveNodeModulesPath(repository, entryPoint),
          `local node_modules (${entryPoint})`,
          repository
        );
        if (result) return result;
      }

      // Try default location
      return tryImporting(resolveNodeModulesPath(repository), 'local node_modules', repository);
    },
  },
  // 3. Check global node_modules
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
  // Special case: local development plugins (for testing)
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
  // Fallback: direct path import
  {
    name: 'direct path',
    tryImport: async (repository: string) => {
      // Only try if it looks like a path
      if (repository.includes('/') || repository.includes('\\')) {
        return tryImporting(repository, 'direct path', repository);
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
        strategy.name === 'workspace package' ||
        strategy.name === 'local node_modules' ||
        strategy.name === 'local development plugin' ||
        strategy.name === 'direct path'
    );
  }
}

/**
 * Attempts to load a plugin module using relevant strategies based on plugin type.
 * Loading order:
 * 1. Workspace packages (if in monorepo)
 * 2. Local node_modules of current workspace
 * 3. Plugin registry (handled by install flow)
 * 4. Global node_modules
 * 5. NPM (handled by install flow)
 * 6. GitHub at /elizaos-plugins/plugin-<n> (handled by install flow)
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

  // Log strategy names
  logger.debug(`Strategies for ${repository}: ${strategies.map((s) => s.name).join(', ')}`);

  for (const strategy of strategies) {
    logger.debug(`Trying strategy: ${strategy.name} for ${repository}`);
    const result = await strategy.tryImport(repository);
    if (result) return result;
  }

  logger.warn(`Failed to load plugin module '${repository}' using all relevant strategies.`);
  return null;
}
