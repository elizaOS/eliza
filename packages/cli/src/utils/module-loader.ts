import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { logger } from '@elizaos/core';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { UserEnvironment } from './user-environment';

/**
 * ModuleLoader provides a clean way to load modules from the project's local node_modules
 * instead of the global CLI's bundled dependencies. This solves singleton pattern issues
 * and ensures consistent module instances across the application.
 */
export class ModuleLoader {
  private require: NodeRequire;
  private asyncCache = new Map<string, any>();
  private syncCache = new Map<string, any>();
  private projectPath: string;

  constructor(projectPath?: string) {
    this.projectPath = projectPath || this.detectProjectPath();
    // Create require function scoped to the project directory
    // This ensures module resolution starts from the project's package.json
    this.require = createRequire(pathToFileURL(path.join(this.projectPath, 'package.json')).href);

    // Set up environment with proper module resolution paths
    // This ensures the same local-first guarantees as server-manager.ts
    this.setupEnvironment();
  }

  /**
   * Detect the appropriate project path, preferring monorepo root over current working directory
   */
  private detectProjectPath(): string {
    // Try to detect monorepo root using existing UserEnvironment utility
    const monorepoRoot = UserEnvironment.getInstance().findMonorepoRoot(process.cwd());
    if (monorepoRoot) {
      logger.debug(`Using monorepo root: ${monorepoRoot}`);
      return monorepoRoot;
    }

    // Fallback to current working directory
    logger.debug(`Using current working directory: ${process.cwd()}`);
    return process.cwd();
  }

  /**
   * Load a module from the project's node_modules directory.
   * Uses caching to ensure the same instance is returned for repeated calls.
   *
   * @param moduleName - The name of the module to load (e.g., '@elizaos/server')
   * @returns The loaded module
   * @throws Error if the module cannot be found in the project
   */
  async load<T = any>(moduleName: string): Promise<T> {
    // Return cached module if already loaded
    if (this.asyncCache.has(moduleName)) {
      logger.debug(`Using cached module: ${moduleName}`);
      return this.asyncCache.get(moduleName);
    }

    try {
      // First, explicitly check if local module exists (same as server-manager.ts logic)
      const localModulePath = path.join(this.projectPath, 'node_modules', moduleName);
      const isLocalModule = existsSync(localModulePath);

      if (isLocalModule) {
        logger.info(`Using local ${moduleName} installation`);
      } else {
        logger.info(`Using global ${moduleName} installation`);
      }

      // Resolve the module path using project-scoped require
      const modulePath = this.require.resolve(moduleName);
      logger.debug(`Loading ${moduleName} from: ${modulePath}`);

      // Verify we're actually using local module when available
      if (isLocalModule && !modulePath.includes(this.projectPath)) {
        logger.warn(`Expected local module but resolved to global: ${modulePath}`);
      }

      // Use dynamic import with file URL for cross-platform compatibility
      const module = await import(pathToFileURL(modulePath).href);

      // Cache the loaded module
      this.asyncCache.set(moduleName, module);

      logger.info(`Loaded ${moduleName} from ${isLocalModule ? 'local' : 'global'} installation`);
      return module;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to load module ${moduleName}: ${errorMessage}`);

      throw new Error(
        `Cannot find module '${moduleName}' in project at ${this.projectPath}.\n` +
          `Please ensure it's installed by running:\n` +
          `  bun add ${moduleName}\n\n` +
          `Original error: ${errorMessage}`
      );
    }
  }

  /**
   * Synchronously load a module from the project's node_modules directory.
   * Uses caching to ensure the same instance is returned for repeated calls.
   *
   * @param moduleName - The name of the module to load (e.g., '@elizaos/server')
   * @returns The loaded module
   * @throws Error if the module cannot be found in the project
   */
  loadSync<T = any>(moduleName: string): T {
    // Return cached module if already loaded
    if (this.syncCache.has(moduleName)) {
      logger.debug(`Using cached module: ${moduleName}`);
      return this.syncCache.get(moduleName);
    }

    try {
      // First, explicitly check if local module exists (same as server-manager.ts logic)
      const localModulePath = path.join(this.projectPath, 'node_modules', moduleName);
      const isLocalModule = existsSync(localModulePath);

      if (isLocalModule) {
        logger.info(`Using local ${moduleName} installation`);
      } else {
        logger.info(`Using global ${moduleName} installation`);
      }

      // Resolve the module path using project-scoped require
      const modulePath = this.require.resolve(moduleName);
      logger.debug(`Loading ${moduleName} from: ${modulePath}`);

      // Verify we're actually using local module when available
      if (isLocalModule && !modulePath.includes(this.projectPath)) {
        logger.warn(`Expected local module but resolved to global: ${modulePath}`);
      }

      // Use require for synchronous loading
      const module = this.require(modulePath);

      // Cache the loaded module
      this.syncCache.set(moduleName, module);

      logger.info(`Loaded ${moduleName} from ${isLocalModule ? 'local' : 'global'} installation`);
      return module;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to load module ${moduleName}: ${errorMessage}`);

      throw new Error(
        `Cannot find module '${moduleName}' in project at ${this.projectPath}.\n` +
          `Please ensure it's installed by running:\n` +
          `  bun add ${moduleName}\n\n` +
          `Original error: ${errorMessage}`
      );
    }
  }

  /**
   * Set up environment with proper module resolution paths.
   * This ensures the same local-first guarantees as server-manager.ts.
   */
  private setupEnvironment(): void {
    // Add local node_modules to NODE_PATH for proper module resolution
    const localModulesPath = path.join(this.projectPath, 'node_modules');
    if (existsSync(localModulesPath)) {
      if (process.env.NODE_PATH) {
        process.env.NODE_PATH = `${localModulesPath}${path.delimiter}${process.env.NODE_PATH}`;
      } else {
        process.env.NODE_PATH = localModulesPath;
      }
    }

    // Add local .bin to PATH to prioritize local executables
    const localBinPath = path.join(this.projectPath, 'node_modules', '.bin');
    if (existsSync(localBinPath)) {
      if (process.env.PATH) {
        process.env.PATH = `${localBinPath}${path.delimiter}${process.env.PATH}`;
      } else {
        process.env.PATH = localBinPath;
      }
    }
  }

  /**
   * Clear the module cache. Useful for testing or hot reloading scenarios.
   */
  clearCache(): void {
    this.asyncCache.clear();
    this.syncCache.clear();
  }

  /**
   * Get the resolved path for a module without loading it.
   * Useful for debugging or verification.
   *
   * @param moduleName - The name of the module to resolve
   * @returns The resolved file path
   */
  resolve(moduleName: string): string {
    return this.require.resolve(moduleName);
  }
}

// Singleton instance for the current project
let defaultLoader: ModuleLoader | null = null;

/**
 * Get the default module loader instance for the current project.
 * Creates a new instance if one doesn't exist.
 */
export function getModuleLoader(): ModuleLoader {
  if (!defaultLoader) {
    defaultLoader = new ModuleLoader();
  }
  return defaultLoader;
}

/**
 * Convenience function to load a module using the default loader.
 *
 * @param moduleName - The name of the module to load
 * @returns The loaded module
 */
export async function loadModule<T = any>(moduleName: string): Promise<T> {
  return getModuleLoader().load<T>(moduleName);
}

/**
 * Convenience function to synchronously load a module using the default loader.
 *
 * @param moduleName - The name of the module to load
 * @returns The loaded module
 */
export function loadModuleSync<T = any>(moduleName: string): T {
  return getModuleLoader().loadSync<T>(moduleName);
}
