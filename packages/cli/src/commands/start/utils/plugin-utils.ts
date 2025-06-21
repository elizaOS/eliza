import { getCliInstallTag, installPlugin, loadPluginModule } from '@/src/utils';
import { detectPluginContext, provideLocalPluginGuidance } from '@/src/utils/plugin-context';
import { logger, type Plugin } from '@elizaos/core';
import { PluginValidation } from '../types';
import { dynamicImport, getEnvironmentConfig } from '@/src/utils/environment-normalization';

/**
 * Check if an object has a valid plugin shape
 */
export function isValidPluginShape(obj: any): obj is Plugin {
  if (!obj || typeof obj !== 'object' || !obj.name) {
    return false;
  }
  return !!(
    obj.init ||
    obj.services ||
    obj.providers ||
    obj.actions ||
    obj.evaluators ||
    obj.description
  );
}

/**
 * Load a plugin module with environment-aware import handling
 */
async function loadPluginModuleWithEnvironment(pluginName: string): Promise<any> {
  // const envConfig = getEnvironmentConfig(); // Available for future environment-based plugin filtering

  try {
    // First try the standard loadPluginModule
    const module = await loadPluginModule(pluginName);
    if (module) return module;
  } catch (error) {
    logger.debug(
      `Standard plugin loading failed for ${pluginName}, trying environment-aware loading`
    );
  }

  // Try environment-aware dynamic import
  try {
    // Handle local plugin paths
    if (pluginName.startsWith('./') || pluginName.startsWith('../')) {
      return await dynamicImport(pluginName);
    }

    // Handle package imports
    return await import(pluginName);
  } catch (error) {
    logger.debug(`Environment-aware loading failed for ${pluginName}:`, error);
    return null;
  }
}

/**
 * Load and prepare a plugin for use
 *
 * Handles both local development plugins and published plugins, with automatic installation if needed.
 */
export async function loadAndPreparePlugin(pluginName: string): Promise<Plugin | null> {
  const version = getCliInstallTag();
  let pluginModule: any;
  const context = detectPluginContext(pluginName);
  const envConfig = getEnvironmentConfig();

  if (context.isLocalDevelopment) {
    try {
      pluginModule = await loadPluginModuleWithEnvironment(pluginName);
      if (!pluginModule) {
        logger.error(`Failed to load local plugin ${pluginName}.`);
        provideLocalPluginGuidance(pluginName, context);
        return null;
      }
    } catch (error) {
      logger.error(`Error loading local plugin ${pluginName}: ${error}`);
      provideLocalPluginGuidance(pluginName, context);

      // Provide additional guidance for common environment issues
      if (error instanceof Error && error.message.includes('Cannot find module')) {
        if (envConfig.requiresJsExtensions) {
          logger.info(
            `Hint: In the built CLI environment, make sure all relative imports have .js extensions`
          );
        }
        if (envConfig.isTypeScript) {
          logger.info(`Hint: In TypeScript environment, you can import .ts files directly`);
        }
      }

      return null;
    }
  } else {
    try {
      pluginModule = await loadPluginModuleWithEnvironment(pluginName);
      if (!pluginModule) {
        logger.info(`Plugin ${pluginName} not available, installing...`);
        await installPlugin(pluginName, process.cwd(), version);
        pluginModule = await loadPluginModuleWithEnvironment(pluginName);
      }
    } catch (error) {
      logger.error(`Failed to process plugin ${pluginName}: ${error}`);
      return null;
    }
  }

  if (!pluginModule) {
    logger.error(`Failed to load module for plugin ${pluginName}.`);
    return null;
  }

  const expectedFunctionName = `${pluginName
    .replace(/^@elizaos\/plugin-/, '')
    .replace(/^@elizaos\//, '')
    .replace(/-./g, (match) => match[1].toUpperCase())}Plugin`;

  const exportsToCheck = [
    pluginModule[expectedFunctionName],
    pluginModule.default,
    ...Object.values(pluginModule),
  ];

  for (const potentialPlugin of exportsToCheck) {
    if (isValidPluginShape(potentialPlugin)) {
      return potentialPlugin as Plugin;
    }
  }

  logger.warn(`Could not find a valid plugin export in ${pluginName}.`);

  // Provide helpful debugging info
  if (envConfig.isMonorepo) {
    logger.info(
      `Running in monorepo context. Make sure the plugin is properly built if using TypeScript.`
    );
  }

  return null;
}

/**
 * Validate a plugin object
 */
export function validatePlugin(plugin: any): PluginValidation {
  if (!plugin) {
    return { isValid: false, error: 'Plugin is null or undefined' };
  }

  if (!isValidPluginShape(plugin)) {
    return { isValid: false, error: 'Plugin does not have valid shape' };
  }

  return { isValid: true, plugin };
}
