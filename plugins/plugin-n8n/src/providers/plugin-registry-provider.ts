import { IAgentRuntime, Memory, Provider, ProviderResult, State } from '@elizaos/core';
import { getPluginCreationService } from '../utils/get-plugin-creation-service.ts';
export const pluginRegistryProvider: Provider = {
  name: 'plugin_registry',
  description: 'Provides information about all created plugins in the current session',
  get: async (runtime: IAgentRuntime, message: Memory, state: State): Promise<ProviderResult> => {
    const service = getPluginCreationService(runtime);

    if (!service) {
      return {
        text: 'Plugin creation service not available',
        data: { error: 'Service not found' },
      };
    }

    const createdPlugins = service.getCreatedPlugins();
    const jobs = service.getAllJobs();

    // Create a map of plugin status
    const pluginStatus = new Map<string, any>();

    for (const job of jobs) {
      pluginStatus.set(job.specification.name, {
        id: job.id,
        status: job.status,
        phase: job.currentPhase,
        progress: job.progress,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        modelUsed: job.modelUsed,
      });
    }

    const registryData = {
      totalCreated: createdPlugins.length,
      plugins: createdPlugins.map((name) => ({
        name,
        ...pluginStatus.get(name),
      })),
      activeJobs: jobs.filter((j) => j.status === 'running' || j.status === 'pending').length,
    };

    return {
      text: `Plugin Registry: ${createdPlugins.length} plugins created, ${registryData.activeJobs} active jobs`,
      data: registryData,
    };
  },
};

export const pluginExistsProvider: Provider = {
  name: 'plugin_exists_check',
  description: 'Checks if a specific plugin has already been created',
  get: async (runtime: IAgentRuntime, message: Memory, state: State): Promise<ProviderResult> => {
    const service = getPluginCreationService(runtime);

    if (!service) {
      return {
        text: 'Plugin creation service not available',
        data: { error: 'Service not found' },
      };
    }

    // Extract plugin name from message
    const pluginNameMatch = message.content.text.match(/@[a-zA-Z0-9-_]+\/[a-zA-Z0-9-_]+/);

    if (!pluginNameMatch) {
      return {
        text: 'No plugin name found in message',
        data: { exists: false },
      };
    }

    const pluginName = pluginNameMatch[0];
    const exists = service.isPluginCreated(pluginName);

    return {
      text: exists
        ? `Plugin ${pluginName} has already been created in this session`
        : `Plugin ${pluginName} has not been created yet`,
      data: {
        pluginName,
        exists,
        createdPlugins: service.getCreatedPlugins(),
      },
    };
  },
};
