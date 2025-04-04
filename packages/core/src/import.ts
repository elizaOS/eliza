import logger from './logger';

const registrations = new Map<string, any>();

export const dynamicImport = async (specifier: string) => {
  const module = registrations.get(specifier);
  if (module !== undefined) {
    return module;
  }
  return await import(specifier);
};

export const registerDynamicImport = (specifier: string, module: any) => {
  registrations.set(specifier, module);
};

/**
 * Determines the version tag based on the core package version.
 * @returns {string} The appropriate version tag (@latest, @beta, or @alpha)
 */
function getVersionTag(): string {
  let versionTag = '@latest';
  try {
    // Using the version from package.json
    const { version: coreVersion } = require('../package.json');

    if (coreVersion.includes('beta')) {
      versionTag = '@beta';
    } else if (coreVersion.includes('alpha')) {
      versionTag = '@alpha';
    }
  } catch (error) {
    logger.warn(`Could not determine core version, using @latest tag: ${error}`);
  }
  return versionTag;
}

/**
 * Handles importing of plugins asynchronously.
 *
 * @param {string[]} plugins - An array of strings representing the plugins to import.
 * @returns {Promise<Function[]>} - A Promise that resolves to an array of imported plugins functions.
 */
/**
 * Handles the importing of plugins based on the provided array of plugin names.
 *
 * @param {string[]} plugins - An array of plugin names to import
 * @returns {Promise<any[]>} - A Promise that resolves to an array of imported plugins
 */
export async function handlePluginImporting(plugins: string[]) {
  if (plugins.length > 0) {
    // Get the core package version to determine which tag to use
    const versionTag = getVersionTag();

    const importedPlugins = await Promise.all(
      plugins.map(async (plugin) => {
        try {
          // Add version tag to plugin name if it doesn't already have a version specified
          const pluginWithTag =
            plugin.includes('@') && plugin.split('@').length > 2
              ? plugin
              : `${plugin}${versionTag}`;

          const importedPlugin = await import(pluginWithTag);
          const functionName = `${plugin
            .replace('@elizaos/plugin-', '')
            .replace('@elizaos-plugins/', '')
            .replace(/-./g, (x) => x[1].toUpperCase())}Plugin`; // Assumes plugin function is camelCased with Plugin suffix

          // Adding exception for local-ai
          if (functionName === 'localAiPlugin') {
            return importedPlugin['localAIPlugin'];
          }

          return importedPlugin.default || importedPlugin[functionName];
        } catch (importError) {
          logger.error(
            `Failed to import plugin: ${plugin} during runtime dynamic import`,
            `coreVersion: ${versionTag}`
          );
          return []; // Return null for failed imports
        }
      })
    );
    return importedPlugins;
  }
  return [];
}
