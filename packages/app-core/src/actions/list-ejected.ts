import type { Action } from "@elizaos/core";
import { listEjectedPlugins } from "../services/plugin-eject";

export const listEjectedAction: Action = {
  name: "LIST_EJECTED_PLUGINS",

  similes: ["SHOW_EJECTED", "EJECTED_PLUGINS", "LIST_LOCAL_PLUGIN_FORKS"],

  description: "List all ejected plugins and their upstream metadata.",

  validate: async () => true,

  handler: async () => {
    const plugins = await listEjectedPlugins();
    if (plugins.length === 0) {
      return {
        text: "No ejected plugins found.",
        success: true,
        data: { count: 0, plugins: [] },
      };
    }

    const lines = plugins.map((p) => {
      const branch = p.upstream?.branch ? `@${p.upstream.branch}` : "";
      return `- ${p.name}${branch} (${p.path})`;
    });
    return {
      text: [`Ejected plugins (${plugins.length}):`, ...lines].join("\n"),
      success: true,
      data: { count: plugins.length, plugins },
    };
  },
};
