import {
  type Action,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from '@elizaos/core';
import { PluginManagerService } from '../services/pluginManagerService';
import type { PluginState } from '../types';

export const loadPluginAction: Action = {
  name: 'LOAD_PLUGIN',
  similes: ['load plugin', 'enable plugin', 'activate plugin', 'start plugin'],
  description: 'Load a plugin that is currently in the ready or unloaded state',

  examples: [
    [
      {
        name: 'Autoliza',
        content: {
          text: 'I need to load the shell plugin',
          actions: ['LOAD_PLUGIN'],
        },
      },
      {
        name: 'Autoliza',
        content: {
          text: 'Loading the shell plugin now.',
          actions: ['LOAD_PLUGIN'],
          simple: true,
        },
      },
    ],
    [
      {
        name: 'Autoliza',
        content: {
          text: 'Activate the example-plugin that is ready',
          actions: ['LOAD_PLUGIN'],
        },
      },
      {
        name: 'Autoliza',
        content: {
          text: "I'll activate the example-plugin for you.",
          actions: ['LOAD_PLUGIN'],
          simple: true,
        },
      },
    ],
  ],

  async validate(runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> {
    const pluginManager = runtime.getService('plugin_manager') as PluginManagerService;

    if (!pluginManager) {
      logger.warn('[loadPluginAction] Plugin Manager service not available');
      return false;
    }

    // Check if the message is asking to load a plugin
    const text = message.content?.text?.toLowerCase() || '';
    const isLoadRequest =
      (text.includes('load') && text.includes('plugin')) ||
      (text.includes('enable') && text.includes('plugin')) ||
      (text.includes('activate') && text.includes('plugin')) ||
      (text.includes('start') && text.includes('plugin'));

    if (!isLoadRequest) {
      return false;
    }

    // Check if there are any plugins that can be loaded
    const plugins = pluginManager.getAllPlugins();
    const loadablePlugins = plugins.filter((p) => p.status === 'ready' || p.status === 'unloaded');

    return loadablePlugins.length > 0;
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<void> {
    const pluginManager = runtime.getService('plugin_manager') as PluginManagerService;

    if (!pluginManager) {
      if (callback) {
        await callback({
          text: 'Plugin Manager service is not available.',
          actions: ['LOAD_PLUGIN'],
        });
      }
      return;
    }

    // Extract plugin name from message
    const messageText = message.content?.text?.toLowerCase() || '';
    const plugins = pluginManager.getAllPlugins();

    // Find plugin to load
    let pluginToLoad: PluginState | null = null;

    // First try exact match
    for (const plugin of plugins) {
      if (
        messageText.includes(plugin.name.toLowerCase()) &&
        (plugin.status === 'ready' || plugin.status === 'unloaded')
      ) {
        pluginToLoad = plugin;
        break;
      }
    }

    // If no exact match, get the first loadable plugin
    if (!pluginToLoad) {
      pluginToLoad = plugins.find((p) => p.status === 'ready' || p.status === 'unloaded') || null;
    }

    if (!pluginToLoad) {
      if (callback) {
        await callback({
          text: 'No plugins are available to load. All plugins are either already loaded or have errors.',
          actions: ['LOAD_PLUGIN'],
        });
      }
      return;
    }

    // Check for missing environment variables
    if (pluginToLoad.missingEnvVars && pluginToLoad.missingEnvVars.length > 0) {
      if (callback) {
        await callback({
          text: `Cannot load plugin ${pluginToLoad.name} because it's missing environment variables: ${pluginToLoad.missingEnvVars.join(', ')}. Please set these variables first.`,
          actions: ['LOAD_PLUGIN'],
        });
      }
      return;
    }

    logger.info(`[loadPluginAction] Loading plugin: ${pluginToLoad.name}`);

    try {
      await pluginManager.loadPlugin({ pluginId: pluginToLoad.id });

      if (callback) {
        await callback({
          text: `Successfully loaded plugin: ${pluginToLoad.name}`,
          actions: ['LOAD_PLUGIN'],
        });
      }
    } catch (error) {
      logger.error(`[loadPluginAction] Failed to load plugin:`, error);
      if (callback) {
        await callback({
          text: `Failed to load plugin ${pluginToLoad.name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          actions: ['LOAD_PLUGIN'],
        });
      }
    }
  },
};
