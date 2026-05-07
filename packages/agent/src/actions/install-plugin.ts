import type {
  Action,
  ActionExample,
  HandlerOptions,
  IAgentRuntime,
} from "@elizaos/core";
import {
  isPluginManagerLike,
  type PluginManagerLike,
} from "../services/plugin-manager-types.js";
import { hasInstallPluginSignal } from "./plugin-action-validation.js";

function getPluginManager(runtime: IAgentRuntime): PluginManagerLike | null {
  const svc = runtime.getService("plugin_manager");
  return isPluginManagerLike(svc) ? svc : null;
}

export const installPluginAction: Action = {
  name: "INSTALL_PLUGIN",
  contexts: ["admin", "settings", "connectors"],
  roleGate: { minRole: "OWNER" },

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
  descriptionCompressed:
    "install plugin yet install use user ask use, enable, set up, install plugin mark available (yet load) plugin download agent restart load",

  validate: async (runtime, message, state) =>
    getPluginManager(runtime) !== null &&
    hasInstallPluginSignal(message, state),

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
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "I'd like to connect Telegram — can you set that up?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Plugin @elizaos/plugin-telegram@1.4.0 installed successfully. The agent will restart to load it.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Add the OpenAI integration for me.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Plugin @elizaos/plugin-openai@2.0.0-beta.0 installed successfully. The agent will restart to load it.",
        },
      },
    ],
  ] as ActionExample[][],
};
