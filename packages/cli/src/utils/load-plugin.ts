import { logger } from '@elizaos/core';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Attempts to import a module from a given path and logs the outcome.
 * @param importPath The path to attempt importing from.
 * @param description A description of the import attempt for logging (e.g., 'direct path', 'local node_modules').
 * @param repository The original plugin repository/package name for logging.
 * @returns The loaded module if successful, null otherwise.
 */
async function tryImporting(
  importPath: string,
  description: string,
  repository: string
): Promise<any | null> {
  try {
    const module = await import(importPath);
    // Check if the resolved path is different from the input (useful for direct imports)
    // This might require more sophisticated checking depending on how 'import' resolves
    const resolvedPath = importPath; // Placeholder - actual resolution might be complex
    logger.debug(
      `Successfully loaded plugin '${repository}' from ${description} (${resolvedPath})`
    );
    return module;
  } catch (error) {
    // Log import failures only at debug level unless it's the final fallback
    logger.debug(`Import failed from ${description} ('${importPath}'): ${error.message}`);
    return null;
  }
}

/**
 * Attempts to load a plugin module using various strategies.
 * It tries direct import, local node_modules, global node_modules,
 * package.json entry points, and common dist patterns.
 *
 * @param repository - The plugin repository/package name to load.
 * @returns The loaded plugin module or null if loading fails after all attempts.
 */
export async function loadPluginModule(repository: string): Promise<any | null> {
  logger.debug(`Attempting to load plugin module: ${repository}`);
  let loadedModule: any | null = null;

  // Strategy 1: Direct import
  loadedModule = await tryImporting(repository, 'direct path', repository);
  if (loadedModule) return loadedModule;

  // Strategy 2: Try local node_modules explicit path
  // Use process.cwd() for local context
  const localNodeModulesPath = path.resolve(process.cwd(), 'node_modules', repository);
  loadedModule = await tryImporting(localNodeModulesPath, 'local node_modules', repository);
  if (loadedModule) return loadedModule;

  // Strategy 3: Try global node_modules explicit path
  // This path might vary, but '/usr/local/lib/node_modules' is common
  // Consider making this configurable or detecting it more dynamically if needed
  // Be cautious with assumptions about global paths.
  const globalNodeModulesPath = path.resolve('/usr/local/lib/node_modules', repository);
  // Check existence first to avoid unnecessary error logs for non-existent global paths
  if (fs.existsSync(path.dirname(globalNodeModulesPath))) {
    // Check if the parent dir exists
    loadedModule = await tryImporting(globalNodeModulesPath, 'global node_modules', repository);
    if (loadedModule) return loadedModule;
  } else {
    logger.debug(
      `Global node_modules directory not found or inaccessible, skipping global check for ${repository}.`
    );
  }

  // Strategy 4: Try to find local package.json and load entry point
  try {
    const localPackageJsonPath = path.resolve(
      process.cwd(),
      'node_modules',
      repository,
      'package.json'
    );
    if (fs.existsSync(localPackageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(localPackageJsonPath, 'utf-8'));
      // Prioritize 'module', then 'main', fallback to 'dist/index.js'
      const entryPoint = packageJson.module || packageJson.main || 'dist/index.js';
      const fullEntryPath = path.resolve(process.cwd(), 'node_modules', repository, entryPoint);

      loadedModule = await tryImporting(
        fullEntryPath,
        `package.json entry point ('${entryPoint}')`,
        repository
      );
      if (loadedModule) return loadedModule;
    }
  } catch (packageJsonError) {
    logger.debug(
      `Local package.json lookup/import failed for '${repository}': ${packageJsonError.message}`
    );
  }

  // Strategy 5: Fallback - try common dist pattern in local node_modules
  const commonDistPath = path.resolve(process.cwd(), 'node_modules', repository, 'dist/index.js');
  // Only try this if it wasn't already tried via package.json main/module
  if (
    !loadedModule &&
    (!fs.existsSync(path.resolve(process.cwd(), 'node_modules', repository, 'package.json')) ||
      JSON.parse(
        fs.readFileSync(
          path.resolve(process.cwd(), 'node_modules', repository, 'package.json'),
          'utf-8'
        )
      ).main !== 'dist/index.js')
  ) {
    loadedModule = await tryImporting(commonDistPath, 'common dist pattern', repository);
    if (loadedModule) return loadedModule;
  }

  // If all strategies failed
  logger.warn(`Failed to load plugin module '${repository}' using all available strategies.`);
  return null;
}
