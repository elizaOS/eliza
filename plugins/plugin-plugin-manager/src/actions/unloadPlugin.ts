import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
  type HandlerCallback,
} from '@elizaos/core';
import { PluginManagerService } from '../services/pluginManagerService';
import type { PluginState } from '../types';

export const unloadPluginAction: Action = {
  name: 'UNLOAD_PLUGIN',
  similes: ['unload plugin', 'disable plugin', 'deactivate plugin', 'stop plugin', 'remove plugin'],
  description: 'Unload a plugin that is currently loaded (except original plugins)',

  examples: [
    [
      {
        name: 'Autoliza',
        content: {
          text: 'I need to unload the example-plugin',
          actions: ['UNLOAD_PLUGIN'],
        },
      },
      {
        name: 'Autoliza',
        content: {
          text: 'Unloading the example-plugin now.',
          actions: ['UNLOAD_PLUGIN'],
          simple: true,
        },
      },
    ],
    [
      {
        name: 'Autoliza',
        content: {
          text: 'Disable the test plugin that is running',
          actions: ['UNLOAD_PLUGIN'],
        },
      },
      {
        name: 'Autoliza',
        content: {
          text: "I'll disable the test plugin for you.",
          actions: ['UNLOAD_PLUGIN'],
          simple: true,
        },
      },
    ],
  ],

  async validate(runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> {
    // Precondition: plugin manager service must be available
    const pluginManager = await runtime.getService('plugin_manager') as PluginManagerService;
    if (!pluginManager) {
      return false;
    }

    // Precondition: at least one loaded plugin can be unloaded
    const plugins = pluginManager.getAllPlugins();
    return plugins.some(
      (p) => p.status === 'loaded' && pluginManager.canUnloadPlugin(p.name)
    );
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<void> {
    const pluginManager = await runtime.getService('plugin_manager') as PluginManagerService;

    if (!pluginManager) {
      if (callback) {
        await callback({
          text: 'Plugin Manager service is not available.',
          actions: ['UNLOAD_PLUGIN'],
        });
      }
      return;
    }

    // Extract plugin name from message
    const messageText = message.content?.text?.toLowerCase() || '';
    const plugins = pluginManager.getAllPlugins();

    // Find plugin to unload
    let pluginToUnload: PluginState | null = null;

    // First try exact match
    for (const plugin of plugins) {
      if (messageText.includes(plugin.name.toLowerCase()) && plugin.status === 'loaded') {
        pluginToUnload = plugin;
        break;
      }
    }

    // If no exact match, provide a list of loaded plugins
    if (!pluginToUnload) {
      const loadedPlugins = plugins.filter((p) => p.status === 'loaded');
      const unloadablePlugins = loadedPlugins.filter((p) => pluginManager.canUnloadPlugin(p.name));

      if (unloadablePlugins.length === 0) {
        if (callback) {
          await callback({
            text: 'No plugins are currently loaded that can be unloaded. All loaded plugins are protected system plugins.',
            actions: ['UNLOAD_PLUGIN'],
          });
        }
        return;
      }

      if (callback) {
        await callback({
          text: `Please specify which plugin to unload. Available plugins that can be unloaded: ${unloadablePlugins.map((p) => p.name).join(', ')}`,
          actions: ['UNLOAD_PLUGIN'],
        });
      }
      return;
    }

    // Check if plugin can be unloaded
    if (!pluginManager.canUnloadPlugin(pluginToUnload.name)) {
      const reason = pluginManager.getProtectionReason(pluginToUnload.name);
      if (callback) {
        await callback({
          text: `Cannot unload plugin: ${reason}`,
          actions: ['UNLOAD_PLUGIN'],
        });
      }
      return;
    }

    logger.info(`[unloadPluginAction] Unloading plugin: ${pluginToUnload.name}`);

    try {
      await pluginManager.unloadPlugin({ pluginId: pluginToUnload.id });

      if (callback) {
        await callback({
          text: `Successfully unloaded plugin: ${pluginToUnload.name}`,
          actions: ['UNLOAD_PLUGIN'],
        });
      }
    } catch (error) {
      logger.error(`[unloadPluginAction] Failed to unload plugin:`, error);
      if (callback) {
        await callback({
          text: `Failed to unload plugin ${pluginToUnload.name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          actions: ['UNLOAD_PLUGIN'],
        });
      }
    }
  },
};
