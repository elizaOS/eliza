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
 * Handles importing of plugins asynchronously.
 *
 * @param {string[]} plugins - An array of strings representing the plugins to import.
 * @returns {Promise<Function[]>} - A Promise that resolves to an array of imported plugins functions.
 */
export async function handlePluginImporting(plugins: string[]) {
  if (plugins.length > 0) {
    const importedPlugins = await Promise.all(
      plugins.map(async (plugin) => {
        try {
          const importedPlugin = await import(plugin);
          const functionName = `${plugin
            .replace('@elizaos/plugin-', '')
            .replace('@elizaos-plugins/', '')
            .replace(/-./g, (x) => x[1].toUpperCase())}Plugin`; // Assumes plugin function is camelCased with Plugin suffix
          return importedPlugin.default || importedPlugin[functionName];
        } catch (importError) {
          logger.error(`Failed to import plugin: ${plugin}`, importError);
          return []; // Return null for failed imports
        }
      })
    );
    return importedPlugins;
  }
  return [];
}
