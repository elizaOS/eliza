import { IAgentRuntime, Memory, Provider, ProviderResult, State } from '@elizaos/core';
import { getPluginCreationService } from '../utils/get-plugin-creation-service.ts';
export const pluginCreationStatusProvider: Provider = {
  name: 'plugin_creation_status',
  description: 'Provides status of active plugin creation jobs',
  get: async (runtime: IAgentRuntime, message: Memory, state: State): Promise<ProviderResult> => {
    const service = getPluginCreationService(runtime);
    if (!service) {
      return {
        text: 'Plugin creation service not available',
      };
    }

    const jobs = service.getAllJobs();
    const activeJobs = jobs.filter((job) => job.status === 'running' || job.status === 'pending');

    if (activeJobs.length === 0) {
      return {
        text: 'No active plugin creation jobs',
      };
    }

    const job = activeJobs[0];
    return {
      text: `Active plugin creation: ${job.specification.name} - Status: ${job.status}, Phase: ${job.currentPhase}, Progress: ${Math.round(job.progress)}%`,
      data: {
        jobId: job.id,
        pluginName: job.specification.name,
        status: job.status,
        phase: job.currentPhase,
        progress: job.progress,
      },
    };
  },
};

export const pluginCreationCapabilitiesProvider: Provider = {
  name: 'plugin_creation_capabilities',
  description: 'Provides information about plugin creation capabilities',
  get: async (runtime: IAgentRuntime, message: Memory, state: State): Promise<ProviderResult> => {
    const service = getPluginCreationService(runtime);
    const hasService = !!service;
    const hasApiKey = !!runtime.getSetting('ANTHROPIC_API_KEY');

    if (!hasService) {
      return {
        text: 'Plugin creation service is not available',
      };
    }

    if (!hasApiKey) {
      return {
        text: 'Plugin creation is available but requires ANTHROPIC_API_KEY for AI-powered code generation',
        data: {
          serviceAvailable: true,
          aiEnabled: false,
        },
      };
    }

    return {
      text: 'Plugin creation service is fully operational with AI-powered code generation',
      data: {
        serviceAvailable: true,
        aiEnabled: true,
        supportedComponents: ['actions', 'providers', 'services', 'evaluators'],
        maxIterations: 5,
      },
    };
  },
};

export { pluginExistsProvider, pluginRegistryProvider } from './plugin-registry-provider.ts';
