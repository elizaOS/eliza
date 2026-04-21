import type { Action, ActionExample, IAgentRuntime } from "@elizaos/core";
import {
  isPluginManagerLike,
  type PluginManagerLike,
} from "../services/plugin-manager-types.js";

function getPluginManager(runtime: IAgentRuntime): PluginManagerLike | null {
  const svc = runtime.getService("plugin_manager");
  return isPluginManagerLike(svc) ? svc : null;
}

export const listEjectedAction: Action = {
  name: "LIST_EJECTED_PLUGINS",

  similes: [
    "SHOW_EJECTED",
    "EJECTED_PLUGINS",
    "LIST_LOCAL_PLUGIN_FORKS",
    "SHOW_FORKED_PLUGINS",
    "LIST_CUSTOMIZED_PLUGINS",
  ],

  description:
    "List every plugin that has been ejected from its npm upstream into a " +
    "local fork in this agent's workspace, together with the fork's upstream " +
    "name, version, and local path. Use this when the owner asks 'which " +
    "plugins have I ejected', 'show my forked plugins', or 'list local plugin " +
    "customizations'. Pairs with EJECT_PLUGIN, REINJECT_PLUGIN, and " +
    "SYNC_PLUGIN for managing the lifecycle of forked plugins.",

  validate: async () => true,

  handler: async (runtime) => {
    const mgr = getPluginManager(runtime);
    if (!mgr) {
      return {
        text: "Plugin manager service is not available.",
        success: false,
      };
    }

    const plugins = await mgr.listEjectedPlugins();
    if (plugins.length === 0) {
      return {
        text: "No ejected plugins found.",
        success: true,
        data: { count: 0, plugins: [] },
      };
    }

    const lines = plugins.map((p) => {
      const ver = p.version ? `@${p.version}` : "";
      return `- ${p.name}${ver}`;
    });
    return {
      text: [`Ejected plugins (${plugins.length}):`, ...lines].join("\n"),
      success: true,
      data: { count: plugins.length, plugins },
    };
  },
  parameters: [],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Which plugins have I forked locally so far?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Ejected plugins (2):\n- @elizaos/plugin-discord@1.4.0\n- @elizaos/plugin-telegram@1.2.1",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Show me my local plugin customizations.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "No ejected plugins found.",
        },
      },
    ],
  ] as ActionExample[][],
};
