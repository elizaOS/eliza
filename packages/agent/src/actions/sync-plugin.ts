import type { Action, HandlerOptions, IAgentRuntime } from "@elizaos/core";

function getPluginManager(runtime: IAgentRuntime) {
  return runtime.getService("plugin_manager") as unknown as {
    syncPlugin(id: string): Promise<{
      success: boolean;
      pluginName: string;
      upstreamCommits: number;
      conflicts: string[];
      error?: string;
    }>;
  } | null;
}

export const syncPluginAction: Action = {
  name: "SYNC_PLUGIN",

  similes: ["UPDATE_PLUGIN", "PULL_PLUGIN_UPSTREAM", "SYNC_EJECTED_PLUGIN"],

  description:
    "Sync an ejected plugin with upstream by fetching and merging new commits.",

  validate: async () => true,

  handler: async (runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters;
    const pluginId =
      typeof params?.pluginId === "string" ? params.pluginId.trim() : "";

    if (!pluginId) {
      return { text: "I need a plugin ID to sync.", success: false };
    }

    const mgr = getPluginManager(runtime);
    if (!mgr) {
      return {
        text: "Plugin manager service is not available.",
        success: false,
      };
    }

    const result = await mgr.syncPlugin(pluginId);
    if (!result.success) {
      const conflictText =
        result.conflicts.length > 0
          ? ` Conflicts: ${result.conflicts.join(", ")}`
          : "";
      return {
        text: `Failed to sync ${pluginId}: ${result.error ?? "unknown error"}.${conflictText}`,
        success: false,
        data: { ...result },
      };
    }

    return {
      text: `Synced ${result.pluginName} (${result.upstreamCommits} upstream commits).`,
      success: true,
      data: { ...result },
    };
  },

  parameters: [
    {
      name: "pluginId",
      description:
        "Plugin ID or npm package to sync (e.g. 'discord' or '@elizaos/plugin-discord')",
      required: true,
      schema: { type: "string" as const },
    },
  ],
};
