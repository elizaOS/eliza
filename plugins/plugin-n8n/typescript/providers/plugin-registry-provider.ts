import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { requireProviderSpec } from "../generated/specs/spec-helpers";
import type { PluginRegistryData } from "../types";
import { getPluginCreationService } from "../utils/get-plugin-creation-service";

const spec = requireProviderSpec("plugin-registry-provider");

export const pluginRegistryProvider: Provider = {
  name: spec.name,
  description: "Provides information about all created plugins in the current session",
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
    const service = getPluginCreationService(runtime);

    if (!service) {
      return {
        text: "Plugin creation service not available",
        data: { error: "Service not found" },
      };
    }

    const createdPlugins = service.getCreatedPlugins();
    const jobs = service.getAllJobs();

    const pluginStatus = new Map<string, Record<string, unknown>>();

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

    const registryData: PluginRegistryData = {
      totalCreated: createdPlugins.length,
      plugins: createdPlugins.map((name) => ({
        name,
        ...pluginStatus.get(name),
      })),
      activeJobs: jobs.filter((j) => j.status === "running" || j.status === "pending").length,
    };

    return {
      text: `Plugin Registry: ${createdPlugins.length} plugins created, ${registryData.activeJobs} active jobs`,
      data: { registry: registryData },
    };
  },
};

export const pluginExistsProvider: Provider = {
  name: "plugin_exists_check",
  description: "Checks if a specific plugin has already been created",
  get: async (runtime: IAgentRuntime, message: Memory, _state: State): Promise<ProviderResult> => {
    const service = getPluginCreationService(runtime);

    if (!service) {
      return {
        text: "Plugin creation service not available",
        data: { error: "Service not found" },
      };
    }

    const pluginNameMatch = message.content.text.match(/@[a-zA-Z0-9-_]+\/[a-zA-Z0-9-_]+/);

    if (!pluginNameMatch) {
      return {
        text: "No plugin name found in message",
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
