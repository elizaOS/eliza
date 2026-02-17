import { type Plugin } from '@elizaos/core';
import { PluginManagerService } from './services/pluginManagerService';
import { PluginConfigurationService } from './services/pluginConfigurationService';
import { loadPluginAction } from './actions/loadPlugin';
import { unloadPluginAction } from './actions/unloadPlugin';
import { installPluginFromRegistryAction } from './actions/installPluginFromRegistry';
import { searchPluginAction, getPluginDetailsAction } from './actions/searchPluginAction';
import { clonePluginAction } from './actions/clonePluginAction';
import { publishPluginAction } from './actions/publishPluginAction';
import { pluginStateProvider } from './providers/pluginStateProvider';
import { pluginConfigurationStatusProvider } from './providers/pluginConfigurationStatus';
import { registryPluginsProvider } from './providers/registryPluginsProvider';
import './types'; // Ensure module augmentation is loaded

/**
 * Plugin Manager Plugin for elizaOS
 *
 * Provides comprehensive plugin management capabilities including:
 * - Dynamic loading and unloading of plugins at runtime
 * - Plugin registry integration with caching for discovering and installing plugins
 * - Basic configuration management for environment variable checking
 * - Plugin search, clone, and publish functionality
 *
 * Core Features:
 * - Search plugins using cached registry data
 * - Install plugins from registry
 * - Load and unload plugins dynamically
 * - Clone plugins for development
 * - Publish plugins to npm registry
 * - Check plugin configuration status and missing API keys
 *
 * IMPORTANT: The agent should use this plugin manager to:
 * - Search for and discover new plugins from the registry
 * - Install plugins to extend its capabilities
 * - Clone plugins for modification and development
 * - Load/unload non-protected plugins as needed
 *
 * Protected plugins (loaded at startup) CANNOT be unloaded or modified
 * to ensure system stability and core functionality.
 */
export const pluginManagerPlugin: Plugin = {
  name: 'plugin-manager',
  description:
    'Manages dynamic loading and unloading of plugins at runtime, with registry integration and configuration status checking',

  services: [PluginManagerService, PluginConfigurationService],

  actions: [
    loadPluginAction,
    unloadPluginAction,
    installPluginFromRegistryAction,
    searchPluginAction,
    getPluginDetailsAction,
    clonePluginAction,
    publishPluginAction,
  ],

  providers: [
    pluginStateProvider,
    pluginConfigurationStatusProvider,
    registryPluginsProvider,
  ],

  evaluators: [],

  routes: [],

  init: async (_config, _runtime) => {
    // Service initialization is handled by the runtime when calling static start()
    // No need to manually initialize here
  },
};
