import type { Action, IAgentRuntime } from "@elizaos/core";
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

  similes: ["SHOW_EJECTED", "EJECTED_PLUGINS", "LIST_LOCAL_PLUGIN_FORKS"],

  description: "List all ejected plugins and their upstream metadata.",

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
};
