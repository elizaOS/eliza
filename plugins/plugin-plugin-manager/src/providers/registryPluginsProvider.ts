import type { IAgentRuntime, Provider, ProviderResult } from '@elizaos/core';
import { PluginManagerService } from '../services/pluginManagerService';
import { getAllPlugins } from '../services/pluginRegistryService';

export const registryPluginsProvider: Provider = {
  name: 'registryPlugins',
  description: 'Provides list of available plugins from the ElizaOS registry using cached data',

  async get(runtime: IAgentRuntime): Promise<ProviderResult> {
    const pluginManagerService = runtime.getService('plugin_manager') as PluginManagerService;

    if (!pluginManagerService) {
      return {
        text: 'Required services not available',
        data: { error: 'Plugin manager service not available' },
      };
    }

    try {
      // Get available plugins from API-based registry
      const pluginsData = await getAllPlugins();
      const plugins = pluginsData.map((plugin) => ({
        name: plugin.name,
        description: plugin.description || 'No description available',
        repository: plugin.repository,
        tags: plugin.tags || [],
        version: plugin.latestVersion,
      }));

      let text = '**Available Plugins from Registry:**\n';
      if (plugins.length === 0) {
        text += 'No plugins available in registry';
      } else {
        for (const plugin of plugins) {
          text += `- **${plugin.name}**: ${plugin.description}\n`;
          if (plugin.tags && plugin.tags.length > 0) {
            text += `  Tags: ${plugin.tags.join(', ')}\n`;
          }
        }
      }

      // Also show installed plugins
      const installedPlugins = pluginManagerService.listInstalledPlugins();
      if (installedPlugins.length > 0) {
        text += '\n**Installed Registry Plugins:**\n';
        for (const plugin of installedPlugins) {
          text += `- **${plugin.name}** v${plugin.version} (${plugin.status})\n`;
        }
      }

      return {
        text,
        data: {
          availablePlugins: plugins,
          installedPlugins: installedPlugins,
        },
        values: {
          availableCount: plugins.length,
          installedCount: installedPlugins.length,
        },
      };
    } catch (error) {
      return {
        text: 'Failed to fetch plugins from registry',
        data: { error: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },
};
