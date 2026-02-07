import {
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from '@elizaos/core';
import { PluginManagerService } from '../services/pluginManagerService';
import { type PluginState, PluginStatus } from '../types';

export const pluginStateProvider: Provider = {
  name: 'pluginState',
  description:
    'Provides information about the current state of all plugins including loaded status, missing environment variables, and errors',

  async get(runtime: IAgentRuntime, message: Memory, state: State): Promise<ProviderResult> {
    const pluginManager = runtime.getService('plugin_manager') as PluginManagerService;

    if (!pluginManager) {
      return {
        text: 'Plugin Manager service is not available',
        values: {},
        data: {
          error: 'Plugin Manager service not found',
        },
      };
    }

    const plugins = pluginManager.getAllPlugins();
    const loadedPlugins = plugins.filter((p) => p.status === PluginStatus.LOADED);
    const errorPlugins = plugins.filter((p) => p.status === PluginStatus.ERROR);
    const readyPlugins = plugins.filter((p) => p.status === PluginStatus.READY);
    const unloadedPlugins = plugins.filter((p) => p.status === PluginStatus.UNLOADED);

    // Format plugin information
    const formatPlugin = (plugin: PluginState) => {
      const parts: string[] = [`${plugin.name} (${plugin.status})`];

      if (plugin.error) {
        parts.push(`Error: ${plugin.error}`);
      }

      if (plugin.loadedAt) {
        parts.push(`Loaded at: ${new Date(plugin.loadedAt).toLocaleString()}`);
      }

      return parts.join(' - ');
    };

    const sections: string[] = [];

    if (loadedPlugins.length > 0) {
      sections.push(
        '**Loaded Plugins:**\n' + loadedPlugins.map((p) => `- ${formatPlugin(p)}`).join('\n')
      );
    }

    if (errorPlugins.length > 0) {
      sections.push(
        '**Plugins with Errors:**\n' + errorPlugins.map((p) => `- ${formatPlugin(p)}`).join('\n')
      );
    }

    if (readyPlugins.length > 0) {
      sections.push(
        '**Ready to Load:**\n' + readyPlugins.map((p) => `- ${formatPlugin(p)}`).join('\n')
      );
    }

    if (unloadedPlugins.length > 0) {
      sections.push(
        '**Unloaded:**\n' + unloadedPlugins.map((p) => `- ${formatPlugin(p)}`).join('\n')
      );
    }

    // Add information about protected and original plugins
    const protectedPlugins = pluginManager.getProtectedPlugins();
    const originalPlugins = pluginManager.getOriginalPlugins();

    if (protectedPlugins.length > 0 || originalPlugins.length > 0) {
      sections.push(
        '**System Plugins:**\n' +
          `- Protected: ${protectedPlugins.join(', ')}\n` +
          `- Original (loaded at startup): ${originalPlugins.join(', ')}`
      );
    }

    const text =
      sections.length > 0 ? sections.join('\n\n') : 'No plugins registered in the Plugin Manager.';

    return {
      text,
      values: {
        totalPlugins: plugins.length,
        loadedCount: loadedPlugins.length,
        errorCount: errorPlugins.length,
        readyCount: readyPlugins.length,
        unloadedCount: unloadedPlugins.length,
        protectedPlugins,
        originalPlugins,
      },
      data: {
        plugins: plugins.map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          error: p.error,
          createdAt: p.createdAt,
          loadedAt: p.loadedAt,
          unloadedAt: p.unloadedAt,
          isProtected: protectedPlugins.includes(p.name),
          isOriginal: originalPlugins.includes(p.name),
        })),
      },
    };
  },
};
