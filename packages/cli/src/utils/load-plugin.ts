import { logger } from '@elizaos/core';

/**
 * Attempts to load a plugin module using Node.js module resolution.
 * This will automatically handle:
 * - Local node_modules
 * - Global node_modules
 * - Monorepo packages (through proper package.json and workspace configuration)
 * - Package entry points
 *
 * @param repository - The plugin repository/package name to load.
 * @returns The loaded plugin module or null if loading fails.
 */
export async function loadPluginModule(repository: string): Promise<any | null> {
  logger.debug(`Attempting to load plugin module: ${repository}`);

  try {
    const module = await import(repository);
    logger.debug(`Successfully loaded plugin '${repository}'`);
    return module;
  } catch (error) {
    logger.warn(
      `Failed to load plugin module '${repository}': ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
