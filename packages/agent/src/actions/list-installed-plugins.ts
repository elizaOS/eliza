/**
 * LIST_INSTALLED_PLUGINS — enumerate plugins known to the runtime.
 *
 * Calls GET /api/plugins (the same endpoint used by PluginsView's `loadPlugins`
 * via `client.getPlugins()`) and filters by status.
 *
 * @module actions/list-installed-plugins
 */

import type { Action, ActionExample, HandlerOptions } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { resolveServerOnlyPort } from "@elizaos/shared/runtime-env";
import { hasOwnerAccess } from "../security/access.js";

function getApiBase(): string {
  const port = resolveServerOnlyPort(process.env);
  return `http://localhost:${port}`;
}

type PluginListFilter =
  | "all"
  | "enabled"
  | "disabled"
  | "installed"
  | "available";

function isPluginListFilter(value: unknown): value is PluginListFilter {
  return (
    value === "all" ||
    value === "enabled" ||
    value === "disabled" ||
    value === "installed" ||
    value === "available"
  );
}

interface PluginInfoShape {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  category?: string;
  source?: "bundled" | "store";
  isActive?: boolean;
  npmName?: string;
  version?: string;
}

interface GetPluginsResponse {
  plugins?: PluginInfoShape[];
}

function matchesFilter(
  plugin: PluginInfoShape,
  filter: PluginListFilter,
): boolean {
  switch (filter) {
    case "enabled":
      return plugin.enabled === true;
    case "disabled":
      return plugin.enabled === false;
    case "installed":
      return plugin.isActive === true || plugin.enabled === true;
    case "available":
      return plugin.isActive !== true && plugin.enabled === false;
    default:
      return true;
  }
}

export const listInstalledPluginsAction: Action = {
  name: "LIST_INSTALLED_PLUGINS",

  similes: [
    "LIST_PLUGINS",
    "SHOW_PLUGINS",
    "ENUMERATE_PLUGINS",
    "WHICH_PLUGINS",
    "GET_PLUGINS",
  ],

  description:
    "List the plugins known to this agent. Filter by 'all', 'enabled', " +
    "'disabled', 'installed' (loaded), or 'available' (known but not loaded). " +
    "Defaults to 'all'.",

  validate: async (runtime, message) => {
    return hasOwnerAccess(runtime, message);
  },

  handler: async (runtime, message, _state, options) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        success: false,
        text: "Permission denied: only the owner may list plugins.",
      };
    }

    const params = (options as HandlerOptions | undefined)?.parameters;
    const filter: PluginListFilter = isPluginListFilter(params?.filter)
      ? params.filter
      : "all";

    try {
      const base = getApiBase();
      const resp = await fetch(`${base}/api/plugins`, {
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await resp.json().catch(() => ({}))) as GetPluginsResponse;

      if (!resp.ok) {
        return {
          success: false,
          text: `Failed to list plugins (${resp.status}).`,
        };
      }

      const allPlugins = Array.isArray(data.plugins) ? data.plugins : [];
      const matching = allPlugins.filter((plugin) =>
        matchesFilter(plugin, filter),
      );

      if (matching.length === 0) {
        return {
          success: true,
          text: `No plugins match filter '${filter}'.`,
          data: { filter, count: 0, plugins: [] },
        };
      }

      const lines = matching.map((plugin) => {
        const status = plugin.enabled ? "enabled" : "disabled";
        const active = plugin.isActive ? " active" : "";
        const ver = plugin.version ? `@${plugin.version}` : "";
        return `- ${plugin.name}${ver} [${plugin.id}] (${status}${active})`;
      });

      return {
        success: true,
        text: [
          `Plugins matching '${filter}' (${matching.length}/${allPlugins.length}):`,
          ...lines,
        ].join("\n"),
        data: { filter, count: matching.length, plugins: matching },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[list-installed-plugins] error: ${msg}`);
      return { success: false, text: `Failed to list plugins: ${msg}` };
    }
  },

  parameters: [
    {
      name: "filter",
      description:
        "Which plugins to list: 'all' (default), 'enabled', 'disabled', 'installed', or 'available'.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["all", "enabled", "disabled", "installed", "available"],
      },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Which plugins are enabled?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Plugins matching 'enabled' (2/12):\n- Discord [discord] (enabled active)\n- OpenAI [openai] (enabled active)",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Show me every plugin." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Plugins matching 'all' (3/3):\n- Discord [discord] (enabled active)\n- Telegram [telegram] (disabled)\n- OpenAI [openai] (enabled active)",
        },
      },
    ],
  ] as ActionExample[][],
};
