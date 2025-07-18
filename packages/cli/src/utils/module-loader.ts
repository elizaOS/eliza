import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { logger } from '@elizaos/core';

/**
 * ModuleLoader provides a clean way to load modules from the project's local node_modules
 * instead of the global CLI's bundled dependencies. This solves singleton pattern issues
 * and ensures consistent module instances across the application.
 */
export class ModuleLoader {
  private require: NodeRequire;
  private cache = new Map<string, any>();
  private projectPath: string;

  constructor(projectPath: string = process.cwd()) {
    this.projectPath = projectPath;
    // Create require function scoped to the project directory
    // This ensures module resolution starts from the project's package.json
    this.require = createRequire(pathToFileURL(projectPath + '/package.json').href);
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
    if (this.cache.has(moduleName)) {
      logger.debug(`Using cached module: ${moduleName}`);
      return this.cache.get(moduleName);
    }

    try {
      // Resolve the module path using project-scoped require
      const modulePath = this.require.resolve(moduleName);
      logger.debug(`Loading ${moduleName} from: ${modulePath}`);
      
      // Use dynamic import with file URL for cross-platform compatibility
      const module = await import(pathToFileURL(modulePath).href);
      
      // Cache the loaded module
      this.cache.set(moduleName, module);
      
      logger.success(`Loaded ${moduleName} from project node_modules`);
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
   * Clear the module cache. Useful for testing or hot reloading scenarios.
   */
  clearCache(): void {
    this.cache.clear();
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