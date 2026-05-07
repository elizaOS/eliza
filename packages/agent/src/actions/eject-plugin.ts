import type {
  Action,
  ActionExample,
  HandlerOptions,
  IAgentRuntime,
} from "@elizaos/core";
import { requestRestart } from "@elizaos/shared";
import {
  isPluginManagerLike,
  type PluginManagerLike,
} from "../services/plugin-manager-types.js";
import { hasEjectPluginSignal } from "./plugin-action-validation.js";

function getPluginManager(runtime: IAgentRuntime): PluginManagerLike | null {
  const svc = runtime.getService("plugin_manager");
  return isPluginManagerLike(svc) ? svc : null;
}

export const ejectPluginAction: Action = {
  name: "EJECT_PLUGIN",
  contexts: ["admin", "settings", "code", "files"],
  roleGate: { minRole: "OWNER" },

  similes: ["EJECT", "FORK_PLUGIN", "CLONE_PLUGIN", "EDIT_PLUGIN_SOURCE"],

  description:
    "Clone a plugin's source code locally so edits override the npm version " +
    "at runtime. Use this before modifying upstream plugin code.",
  descriptionCompressed:
    "clone plugin source code locally edit override npm version runtime use before modify upstream plugin code",

  validate: async (runtime, message, state) =>
    getPluginManager(runtime) !== null && hasEjectPluginSignal(message, state),

  handler: async (runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters;
    const pluginId =
      typeof params?.pluginId === "string" ? params.pluginId.trim() : "";

    if (!pluginId) {
      return { text: "I need a plugin ID to eject.", success: false };
    }

    const mgr = getPluginManager(runtime);
    if (!mgr) {
      return {
        text: "Plugin manager service is not available.",
        success: false,
      };
    }

    const result = await mgr.ejectPlugin(pluginId);
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
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "I want to edit the discord plugin source — pull it local for me.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Ejected @elizaos/plugin-discord to ./plugins/plugin-discord. Restarting to load local source.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Fork the telegram plugin locally so I can patch it.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Ejected @elizaos/plugin-telegram to ./plugins/plugin-telegram. Restarting to load local source.",
        },
      },
    ],
  ] as ActionExample[][],
};
