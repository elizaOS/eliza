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
  description: 'Provides basic plugin configuration status and missing environment variables',

  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const configService = runtime.getService(
      PluginManagerServiceType.PLUGIN_CONFIGURATION
    ) as PluginConfigurationService;
    const pluginManagerService = runtime.getService(PluginManagerServiceType.PLUGIN_MANAGER) as PluginManagerService | null;

    if (!configService) {
      return {
        text: 'Configuration service not available',
        data: { available: false },
        values: { configurationServicesAvailable: false },
      };
    }

    interface PluginConfigStatus {
      name: string;
      status: string;
      requiredVars: number;
      missingVars: number;
      configured: boolean;
      variables: Array<{
        name: string;
        description: string;
        required: boolean;
        sensitive: boolean;
        configured: boolean;
      }>;
    }

    const statusData: {
      available: boolean;
      plugins: PluginConfigStatus[];
      totalPlugins: number;
      configuredPlugins: number;
      needsConfiguration: number;
    } = {
      available: true,
      plugins: [],
      totalPlugins: 0,
      configuredPlugins: 0,
      needsConfiguration: 0,
    };

    let statusText = '';

    // Get all plugins if plugin manager is available
    if (pluginManagerService) {
      const allPlugins = pluginManagerService.getAllPlugins();
      statusData.totalPlugins = allPlugins.length;

      for (const plugin of allPlugins) {
        try {
          // Try to parse plugin requirements
          const result = await configService.parsePluginRequirements(`./plugins/${plugin.name}`);

          if (result && result.requiredVars.length > 0) {
            // Check configuration status
            const missingVars = await configService.getMissingEnvVars(
              plugin.name,
              `./plugins/${plugin.name}`
            );

            const pluginStatus = {
              name: plugin.name,
              status: plugin.status,
              requiredVars: result.requiredVars.length,
              missingVars: missingVars.length,
              configured: missingVars.length === 0,
              variables: result.requiredVars.map((v) => ({
                name: v.name,
                description: v.description,
                required: v.required,
                sensitive: v.sensitive,
                configured: !missingVars.includes(v.name),
              })),
            };

            statusData.plugins.push(pluginStatus);

            if (pluginStatus.configured) {
              statusData.configuredPlugins++;
            } else {
              statusData.needsConfiguration++;
            }
          } else {
            // Plugin doesn't require configuration
            statusData.plugins.push({
              name: plugin.name,
              status: plugin.status,
              requiredVars: 0,
              missingVars: 0,
              configured: true,
              variables: [],
            });
            statusData.configuredPlugins++;
          }
        } catch (error) {
          logger.warn(`[pluginConfigurationStatus] Failed to check ${plugin.name}:`, error);
          // Assume configured if we can't check
          statusData.plugins.push({
            name: plugin.name,
            status: plugin.status,
            requiredVars: 0,
            missingVars: 0,
            configured: true,
            variables: [],
          });
          statusData.configuredPlugins++;
        }
      }
    }

    // Build status text
    if (statusData.totalPlugins === 0) {
      statusText = 'No plugins are currently installed.';
    } else {
      statusText += `Plugin Configuration Status:\n`;
      statusText += `• Total plugins: ${statusData.totalPlugins}\n`;
      statusText += `• Fully configured: ${statusData.configuredPlugins}\n`;
      statusText += `• Need configuration: ${statusData.needsConfiguration}\n`;

      if (statusData.needsConfiguration > 0) {
        statusText += `\nPlugins needing configuration:\n`;
        statusData.plugins
          .filter((p) => !p.configured)
          .forEach((plugin) => {
            statusText += `• ${plugin.name}: ${plugin.missingVars} missing variables\n`;
          });
      }
    }

    return {
      text: statusText,
      data: statusData,
      values: {
        configurationServicesAvailable: true,
        totalPlugins: statusData.totalPlugins,
        configuredPlugins: statusData.configuredPlugins,
        needsConfiguration: statusData.needsConfiguration,
        hasUnconfiguredPlugins: statusData.needsConfiguration > 0,
      },
    };
  },
};
