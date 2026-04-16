import type { Action, HandlerOptions, IAgentRuntime } from "@elizaos/core";
import { isPluginManagerLike, type PluginManagerLike } from "../services/plugin-manager-types.js";

function getPluginManager(runtime: IAgentRuntime): PluginManagerLike | null {
  const svc = runtime.getService("plugin_manager");
  return isPluginManagerLike(svc) ? svc : null;
}

export const installPluginAction: Action = {
  name: "INSTALL_PLUGIN",

  similes: [
    "INSTALL",
    "ADD_PLUGIN",
    "ENABLE_PLUGIN",
    "SETUP_PLUGIN",
    "GET_PLUGIN",
  ],

  description:
    "Install a plugin that is not yet installed. Use this when a user asks to " +
    "use, enable, set up, or install a plugin that is marked [available] " +
    "(not yet loaded). The plugin will be downloaded and the agent will " +
    "restart to load it.",

  validate: async () => true,

  handler: async (runtime, _message, _state, options) => {
    try {
      const params = (options as HandlerOptions | undefined)?.parameters;
      const pluginId =
        typeof params?.pluginId === "string"
          ? params.pluginId.trim()
          : undefined;

      if (!pluginId) {
        return { text: "I need a plugin ID to install.", success: false };
      }

      const mgr = getPluginManager(runtime);
      if (!mgr) {
        return {
          text: "Plugin manager service is not available. Ensure the plugin manager capability is enabled.",
          success: false,
        };
      }

      const npmName = pluginId.startsWith("@")
        ? pluginId
        : `@elizaos/plugin-${pluginId}`;

      const result = await mgr.installPlugin(npmName);

      if (!result.success) {
        return {
          text: `Failed to install ${pluginId}: ${result.error ?? "unknown error"}`,
          success: false,
        };
      }

      return {
        text: `Plugin ${result.pluginName}@${result.version} installed successfully.${result.requiresRestart ? " The agent will restart to load it." : ""}`,
        success: true,
        data: { pluginId, npmName, ...result },
      };
    } catch (err) {
      return {
        text: `Install failed: ${err instanceof Error ? err.message : String(err)}`,
        success: false,
      };
    }
  },

  parameters: [
    {
      name: "pluginId",
      description:
        "The short plugin ID to install (e.g. 'telegram', 'discord', 'polymarket')",
      required: true,
      schema: { type: "string" as const },
    },
  ],
};
