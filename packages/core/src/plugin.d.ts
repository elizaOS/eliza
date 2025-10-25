import type { Plugin } from './types';
/**
 * Attempt to install a plugin using Bun
 * Returns true if installation succeeded, false otherwise
 */
export declare function tryInstallPlugin(pluginName: string): Promise<boolean>;
/**
 * Check if an object has a valid plugin shape
 */
export declare function isValidPluginShape(obj: unknown): obj is Plugin;
/**
 * Validate a plugin's structure
 */
export declare function validatePlugin(plugin: unknown): {
    isValid: boolean;
    errors: string[];
};
/**
 * Load and prepare a plugin for use
 */
export declare function loadAndPreparePlugin(pluginName: string): Promise<Plugin | null>;
/**
 * Resolve plugin dependencies with circular dependency detection
 * Performs topological sorting of plugins to ensure dependencies are loaded in the correct order
 */
export declare function resolvePluginDependencies(availablePlugins: Map<string, Plugin>, isTestMode?: boolean): Plugin[];
/**
 * Load a plugin by name or validate a provided plugin object
 * @param nameOrPlugin - Plugin name string or Plugin object
 * @returns Loaded Plugin or null if failed
 */
export declare function loadPlugin(nameOrPlugin: string | Plugin): Promise<Plugin | null>;
/**
 * Resolve multiple plugins with dependency ordering
 * Browser-compatible wrapper that handles Node.js-only plugin loading
 *
 * @param plugins - Array of plugin names or Plugin objects
 * @param isTestMode - Whether to include test dependencies
 * @returns Ordered array of resolved plugins
 *
 * Note: In browser environments, string plugin names are not supported.
 * Only pre-resolved Plugin objects can be used.
 */
export declare function resolvePlugins(plugins: (string | Plugin)[], isTestMode?: boolean): Promise<Plugin[]>;
//# sourceMappingURL=plugin.d.ts.map