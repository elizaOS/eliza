import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { PluginManagerService } from '../services/pluginManagerService';
import { getAllPlugins } from '../services/pluginRegistryService';

export const registryPluginsProvider: Provider = {
  name: 'registryPlugins',
  description:
    'Provides available plugins from the elizaOS registry, installed plugin status, and searchable plugin knowledge',

  async get(runtime: IAgentRuntime, message: Memory, state: State): Promise<ProviderResult> {
    const pluginManagerService = runtime.getService('plugin_manager') as PluginManagerService;

    if (!pluginManagerService) {
      return {
        text: 'Plugin manager service not available',
        data: { error: 'Plugin manager service not available' },
      };
    }

    try {
      // Get available plugins from API-based registry
      const registryResult = await getAllPlugins();

      if (!registryResult.fromApi) {
        // API is unreachable - report it honestly instead of showing empty
        const installedPlugins = pluginManagerService.listInstalledPlugins();
        let text = `**Registry unavailable:** ${registryResult.error}\n`;
        if (installedPlugins.length > 0) {
          text += '\n**Locally Installed Plugins:**\n';
          for (const plugin of installedPlugins) {
            text += `- **${plugin.name}** v${plugin.version} (${plugin.status})\n`;
          }
        }
        return {
          text,
          data: {
            availablePlugins: [],
            installedPlugins,
            registryError: registryResult.error,
          },
          values: {
            availableCount: 0,
            installedCount: installedPlugins.length,
            registryAvailable: false,
          },
        };
      }

      const pluginsData = registryResult.data;
      const plugins = pluginsData.map((plugin) => ({
        name: plugin.name,
        description: plugin.description || 'No description available',
        repository: plugin.repository,
        tags: plugin.tags || [],
        version: plugin.latestVersion,
      }));

      // Build combined text output
      let text = '';

      // Registry catalog
      if (plugins.length === 0) {
        text += 'No plugins available in registry.\n';
      } else {
        text += `**Available Plugins from Registry (${plugins.length} total):**\n`;
        for (const plugin of plugins) {
          text += `- **${plugin.name}**: ${plugin.description}\n`;
          if (plugin.tags && plugin.tags.length > 0) {
            text += `  Tags: ${plugin.tags.join(', ')}\n`;
          }
        }
      }

      // Installed registry plugins
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
          registryAvailable: true,
        },
      };
    } catch (error) {
      logger.error('[registryPluginsProvider] Failed to fetch registry plugins:', error);
      return {
        text: 'Failed to fetch plugins from registry.',
        data: { error: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },
};
