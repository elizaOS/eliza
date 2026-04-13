import type { Action, HandlerOptions } from "@elizaos/core";
import { requestRestart } from "@elizaos/shared/restart";
import { ejectPlugin } from "../services/plugin-eject";

export const ejectPluginAction: Action = {
  name: "EJECT_PLUGIN",

  similes: ["EJECT", "FORK_PLUGIN", "CLONE_PLUGIN", "EDIT_PLUGIN_SOURCE"],

  description:
    "Clone a plugin's source code locally so edits override the npm version " +
    "at runtime. Use this before modifying upstream plugin code.",

  validate: async () => true,

  handler: async (_runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters;
    const pluginId =
      typeof params?.pluginId === "string" ? params.pluginId.trim() : "";

    if (!pluginId) {
      return { text: "I need a plugin ID to eject.", success: false };
    }

    const result = await ejectPlugin(pluginId);
    if (!result.success) {
      return {
        text: `Failed to eject ${pluginId}: ${result.error ?? "unknown error"}`,
        success: false,
      };
    }

    setTimeout(() => {
      requestRestart(`Plugin ${result.pluginName} ejected`);
    }, 1_000);

    return {
      text: `Ejected ${result.pluginName} to ${result.ejectedPath}. Restarting to load local source.`,
      success: true,
      data: { ...result },
    };
  },

  parameters: [
    {
      name: "pluginId",
      description:
        "Plugin ID or npm package to eject (e.g. 'discord' or '@elizaos/plugin-discord')",
      required: true,
      schema: { type: "string" as const },
    },
  ],
};
