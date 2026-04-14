import type { Action, IAgentRuntime } from "@elizaos/core";

interface EjectedPluginInfo {
  name: string;
  path: string;
  upstream?: { branch?: string };
}

function getPluginManager(runtime: IAgentRuntime) {
  return runtime.getService("plugin_manager") as {
    listEjectedPlugins(): Promise<EjectedPluginInfo[]>;
  } | null;
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
