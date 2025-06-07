import { logger, type Plugin } from '@elizaos/core';
import { getCliInstallTag } from './index';
import { detectPluginContext, provideLocalPluginGuidance } from './plugin-context';
import { loadPluginModule } from './load-plugin';
import { installPlugin } from './install-plugin';

/**
 * Checks if an object has the basic shape of a Plugin (name + at least one functional property).
 * @param obj The object to check.
 * @returns True if the object has a valid plugin shape, false otherwise.
 */
export function isValidPluginShape(obj: any): obj is Plugin {
  if (!obj || typeof obj !== 'object' || !obj.name) {
    return false;
  }
  // Check for the presence of at least one key functional property
  return !!(
    obj.init ||
    obj.services ||
    obj.providers ||
    obj.actions ||
    obj.memoryManagers ||
    obj.componentTypes ||
    obj.evaluators ||
    obj.adapter ||
    obj.models ||
    obj.events ||
    obj.routes ||
    obj.tests ||
    obj.config ||
    obj.description // description is also mandatory technically
  );
}

/**
 * Attempts to load a plugin module, installing it if necessary.
 * Handles various export patterns (default, named export).
 *
 * @param pluginName The name or path of the plugin.
 * @returns The loaded Plugin object, or null if loading/installation fails.
 */
export async function loadAndPreparePlugin(pluginName: string): Promise<Plugin | null> {
  const version = getCliInstallTag();
  let pluginModule: any;

  // Check if this is a local development scenario BEFORE attempting any loading
  const context = detectPluginContext(pluginName);

  if (context.isLocalDevelopment) {
    logger.debug(`Local plugin development detected for: ${pluginName}`);

    // For local development, we should never try to install - just load directly
    try {
      pluginModule = await loadPluginModule(pluginName);
      if (!pluginModule) {
        logger.error(`Failed to load local plugin ${pluginName}.`);
        provideLocalPluginGuidance(pluginName, context);
        return null;
      }
    } catch (error) {
      logger.error(`Error loading local plugin ${pluginName}: ${error}`);
      provideLocalPluginGuidance(pluginName, context);
      return null;
    }
  } else {
    // External plugin - use existing logic
    try {
      // Use the centralized loader first
      pluginModule = await loadPluginModule(pluginName);

      if (!pluginModule) {
        // If loading failed, try installing and then loading again
        logger.info(`Plugin ${pluginName} not available, installing into ${process.cwd()}...`);
        try {
          await installPlugin(pluginName, process.cwd(), version);
          // Try loading again after installation using the centralized loader
          pluginModule = await loadPluginModule(pluginName);
        } catch (installError) {
          logger.error(`Failed to install plugin ${pluginName}: ${installError}`);
          return null; // Installation failed
        }

        if (!pluginModule) {
          logger.error(`Failed to load plugin ${pluginName} even after installation.`);
          return null; // Loading failed post-installation
        }
      }
    } catch (error) {
      // Catch any unexpected error during the combined load/install/load process
      logger.error(`An unexpected error occurred while processing plugin ${pluginName}: ${error}`);
      return null;
    }
  }

  if (!pluginModule) {
    // This check might be redundant now, but kept for safety.
    logger.error(`Failed to process plugin ${pluginName} (module is null/undefined unexpectedly)`);
    return null;
  }

  // Construct the expected camelCase export name (e.g., @elizaos/plugin-foo-bar -> fooBarPlugin)
  const expectedFunctionName = `${pluginName
    .replace(/^@elizaos\/plugin-/, '') // Remove prefix
    .replace(/^@elizaos-plugins\//, '') // Remove alternative prefix
    .replace(/-./g, (match) => match[1].toUpperCase())}Plugin`; // Convert kebab-case to camelCase and add 'Plugin' suffix

  // 1. Prioritize the expected named export if it exists
  const expectedExport = pluginModule[expectedFunctionName];
  if (isValidPluginShape(expectedExport)) {
    logger.success(`Found valid plugin export using expected name: ${expectedFunctionName}`);
    return expectedExport as Plugin;
  }

  // 2. Check the default export if the named one wasn't found or valid
  const defaultExport = pluginModule.default;
  if (isValidPluginShape(defaultExport)) {
    // Ensure it's not the same invalid object we might have checked above
    if (expectedExport !== defaultExport) {
      logger.success('Found valid plugin export using default export');
      return defaultExport as Plugin;
    }
  }

  // 3. If neither primary method worked, search all exports aggressively
  for (const key of Object.keys(pluginModule)) {
    if (key === expectedFunctionName || key === 'default') {
      continue;
    }

    const potentialPlugin = pluginModule[key];
    if (isValidPluginShape(potentialPlugin)) {
      return potentialPlugin as Plugin;
    }
  }

  logger.warn(
    `Could not find a valid plugin export in ${pluginName}. Checked exports: ${expectedFunctionName} (if exists), default (if exists), and others. Available exports: ${Object.keys(pluginModule).join(', ')}`
  );
  return null;
}
