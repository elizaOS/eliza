import {
  type IAgentRuntime,
  type Memory,
  type Provider,
  type State,
  logger,
} from '@elizaos/core';
import { PluginConfigurationService } from '../services/pluginConfigurationService';
import { PluginManagerService } from '../services/pluginManagerService';
import { PluginManagerServiceType } from '../types';

export const pluginConfigurationStatusProvider: Provider = {
  name: 'pluginConfigurationStatus',
  description: 'Provides plugin configuration status based on actual plugin config schemas',

  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const configService = (await runtime.getService(
      PluginManagerServiceType.PLUGIN_CONFIGURATION
    )) as PluginConfigurationService | null;
    const pluginManagerService = (await runtime.getService(
      PluginManagerServiceType.PLUGIN_MANAGER
    )) as PluginManagerService | null;

    if (!configService || !pluginManagerService) {
      return {
        text: 'Configuration or plugin manager service not available',
        data: { available: false },
        values: { configurationServicesAvailable: false },
      };
    }

    const allPlugins = pluginManagerService.getAllPlugins();

    let configuredCount = 0;
    let needsConfigCount = 0;
    const pluginStatuses: Array<{
      name: string;
      status: string;
      configured: boolean;
      missingKeys: string[];
      totalKeys: number;
    }> = [];

    for (const pluginState of allPlugins) {
      if (!pluginState.plugin) {
        // Plugin not loaded, can't check config
        pluginStatuses.push({
          name: pluginState.name,
          status: pluginState.status,
          configured: true, // Unknown - can't check
          missingKeys: [],
          totalKeys: 0,
        });
        configuredCount++;
        continue;
      }

      const configStatus = configService.getPluginConfigStatus(pluginState.plugin);
      pluginStatuses.push({
        name: pluginState.name,
        status: pluginState.status,
        configured: configStatus.configured,
        missingKeys: configStatus.missingKeys,
        totalKeys: configStatus.totalKeys,
      });

      if (configStatus.configured) {
        configuredCount++;
      } else {
        needsConfigCount++;
      }
    }

    // Build status text
    let statusText = '';
    if (allPlugins.length === 0) {
      statusText = 'No plugins registered.';
    } else {
      statusText += `Plugin Configuration Status:\n`;
      statusText += `Total: ${allPlugins.length}, Configured: ${configuredCount}, Needs config: ${needsConfigCount}\n`;

      if (needsConfigCount > 0) {
        statusText += `\nPlugins needing configuration:\n`;
        for (const ps of pluginStatuses.filter((p) => !p.configured)) {
          statusText += `- ${ps.name}: missing ${ps.missingKeys.join(', ')}\n`;
        }
      }
    }

    return {
      text: statusText,
      data: { plugins: pluginStatuses },
      values: {
        configurationServicesAvailable: true,
        totalPlugins: allPlugins.length,
        configuredPlugins: configuredCount,
        needsConfiguration: needsConfigCount,
        hasUnconfiguredPlugins: needsConfigCount > 0,
      },
    };
  },
};
