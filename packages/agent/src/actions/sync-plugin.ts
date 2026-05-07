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
import { hasSyncPluginSignal } from "./plugin-action-validation.js";

function getPluginManager(runtime: IAgentRuntime): PluginManagerLike | null {
  const svc = runtime.getService("plugin_manager");
  return isPluginManagerLike(svc) ? svc : null;
}

export const syncPluginAction: Action = {
  name: "SYNC_PLUGIN",
  contexts: ["admin", "settings", "code", "files"],
  roleGate: { minRole: "OWNER" },

  similes: ["UPDATE_PLUGIN", "PULL_PLUGIN_UPSTREAM", "SYNC_EJECTED_PLUGIN"],

  description:
    "Sync an ejected plugin with upstream by fetching and merging new commits.",
  descriptionCompressed: "sync eject plugin w/ upstream fetch merge new commit",

  validate: async (runtime, message, state) =>
    getPluginManager(runtime) !== null && hasSyncPluginSignal(message, state),

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
      return {
        text: `Failed to sync ${pluginId}: ${result.error ?? "unknown error"}.`,
        success: false,
        data: { ...result },
      };
    }

    return {
      text: `Synced ${result.pluginName}.`,
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
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Pull the latest upstream changes into my forked discord plugin.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Synced @elizaos/plugin-discord.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Update my ejected telegram plugin from upstream.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Synced @elizaos/plugin-telegram.",
        },
      },
    ],
  ] as ActionExample[][],
};
