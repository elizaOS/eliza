// Re-export from modular structure
export { plugins, pluginsCommand } from './plugins/index';

// Re-export utility functions for backward compatibility
export { normalizePluginNameForDisplay, findPluginPackageName, extractPackageName } from './plugins/utils/naming';
