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
import { hasReinjectPluginSignal } from "./plugin-action-validation.js";

function getPluginManager(runtime: IAgentRuntime): PluginManagerLike | null {
  const svc = runtime.getService("plugin_manager");
  return isPluginManagerLike(svc) ? svc : null;
}

export const reinjectPluginAction: Action = {
  name: "REINJECT_PLUGIN",
  contexts: ["admin", "settings", "code", "files"],
  roleGate: { minRole: "OWNER" },

  similes: ["UNEJECT_PLUGIN", "RESTORE_PLUGIN", "REMOVE_LOCAL_PLUGIN"],

  description:
    "Remove an ejected plugin copy so runtime falls back to the npm package.",
  descriptionCompressed:
    "remove eject plugin copy runtime fall back npm package",

  validate: async (runtime, message, state) =>
    getPluginManager(runtime) !== null &&
    hasReinjectPluginSignal(message, state),

  handler: async (runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters;
    const pluginId =
      typeof params?.pluginId === "string" ? params.pluginId.trim() : "";

    if (!pluginId) {
      return { text: "I need a plugin ID to reinject.", success: false };
    }

    const mgr = getPluginManager(runtime);
    if (!mgr) {
      return {
        text: "Plugin manager service is not available.",
        success: false,
      };
    }

    const result = await mgr.reinjectPlugin(pluginId);
    if (!result.success) {
      return {
        text: `Failed to reinject ${pluginId}: ${result.error ?? "unknown error"}`,
        success: false,
      };
    }

    setTimeout(() => {
      requestRestart(`Plugin ${result.pluginName} reinjected`);
    }, 1_000);

    return {
      text: `Removed ejected plugin ${result.pluginName}. Restarting to load npm version.`,
      success: true,
      data: { ...result },
    };
  },

  parameters: [
    {
      name: "pluginId",
      description:
        "Plugin ID or npm package to reinject (e.g. 'discord' or '@elizaos/plugin-discord')",
      required: true,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Throw away my local edits to the discord plugin and go back to the npm version.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Removed ejected plugin @elizaos/plugin-discord. Restarting to load npm version.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Reset the telegram plugin to the published release.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Removed ejected plugin @elizaos/plugin-telegram. Restarting to load npm version.",
        },
      },
    ],
  ] as ActionExample[][],
};
