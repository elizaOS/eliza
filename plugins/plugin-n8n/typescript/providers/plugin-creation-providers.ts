import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { PluginRegistryData } from "../types";
import { getPluginCreationService } from "../utils/get-plugin-creation-service";

/**
 * Provider: Active plugin creation job status.
 *
 * Only emits text when a job is actively running or pending.
 * Gives the LLM context about in-progress builds so it can route
 * status/cancel requests to the right actions.
 */
export const pluginCreationStatusProvider: Provider = {
  name: "n8n_plugin_status",
  description: "Active plugin creation job status and progress",
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
    const service = getPluginCreationService(runtime);
    if (!service) {
      return { text: "" };
    }

    const jobs = service.getAllJobs();
    const activeJobs = jobs.filter((job) => job.status === "running" || job.status === "pending");

    if (activeJobs.length === 0) {
      return { text: "" };
    }

    const job = activeJobs[0];
    const text =
      `# Active Plugin Build\n\n` +
      `A plugin creation job is in progress:\n` +
      `- Plugin: ${job.specification.name}\n` +
      `- Status: ${job.status}\n` +
      `- Phase: ${job.currentPhase}\n` +
      `- Progress: ${Math.round(job.progress)}%\n` +
      `- Job ID: ${job.id}\n\n` +
      `Use CHECK_PLUGIN_STATUS to get detailed progress.\n` +
      `Use CANCEL_PLUGIN to stop this build.`;

    return {
      text,
      data: {
        jobId: job.id,
        pluginName: job.specification.name,
        status: job.status,
        phase: job.currentPhase,
        progress: job.progress,
      },
      values: {
        hasActivePluginBuild: true,
      },
    };
  },
};

/**
 * Provider: Plugin registry — all created plugins + exists checks.
 *
 * Merges the old pluginRegistryProvider and pluginExistsProvider.
 * Only emits text when plugins have been created in this session.
 */
export const pluginRegistryProvider: Provider = {
  name: "n8n_plugin_registry",
  description: "Registry of all plugins created in this session",
  get: async (runtime: IAgentRuntime, message: Memory, _state: State): Promise<ProviderResult> => {
    const service = getPluginCreationService(runtime);
    if (!service) {
      return { text: "" };
    }

    const createdPlugins = service.getCreatedPlugins();
    const jobs = service.getAllJobs();

    if (createdPlugins.length === 0 && jobs.length === 0) {
      return { text: "" };
    }

    const pluginStatus = new Map<string, Record<string, unknown>>();
    for (const job of jobs) {
      pluginStatus.set(job.specification.name, {
        id: job.id,
        status: job.status,
        phase: job.currentPhase,
        progress: job.progress,
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

    // Check if a specific plugin is referenced in the message
    const pluginNameMatch = message.content.text?.match(/@[a-zA-Z0-9-_]+\/[a-zA-Z0-9-_]+/);
    let existsNote = "";
    if (pluginNameMatch) {
      const pluginName = pluginNameMatch[0];
      const exists = service.isPluginCreated(pluginName);
      existsNote = exists
        ? `\nNote: ${pluginName} has already been created in this session.`
        : `\nNote: ${pluginName} has not been created yet.`;
    }

    const pluginList = createdPlugins
      .map((name) => {
        const info = pluginStatus.get(name);
        const statusStr = info ? ` (${info.status})` : " (completed)";
        return `- ${name}${statusStr}`;
      })
      .join("\n");

    const text =
      `# Plugin Registry\n\n` +
      `${createdPlugins.length} plugin(s) created this session:\n` +
      `${pluginList}\n` +
      `${registryData.activeJobs > 0 ? `\n${registryData.activeJobs} active build(s) in progress.` : ""}` +
      `${existsNote}`;

    return {
      text,
      data: { registry: registryData },
      values: {
        pluginCount: createdPlugins.length,
        activeJobs: registryData.activeJobs,
      },
    };
  },
};
