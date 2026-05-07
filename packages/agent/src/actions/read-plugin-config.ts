/**
 * READ_PLUGIN_CONFIG — return the current configuration of a named plugin.
 *
 * Mirrors the data returned by GET /api/plugins and filters to the requested
 * plugin, exposing its parameter definitions and current (non-sensitive) values.
 */

import type { Action, ActionExample, HandlerOptions } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { resolveServerOnlyPort } from "@elizaos/shared";

function getApiBase(): string {
  const port = resolveServerOnlyPort(process.env);
  return `http://localhost:${port}`;
}

interface PluginParamEntry {
  key: string;
  type?: string;
  description?: string;
  required?: boolean;
  sensitive?: boolean;
  isSet?: boolean;
  currentValue?: string | null;
}

interface PluginListEntry {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  configured: boolean;
  version?: string;
  parameters: PluginParamEntry[];
  configKeys?: string[];
  loadError?: string;
}

interface PluginsListResponse {
  plugins: PluginListEntry[];
}

export const readPluginConfigAction: Action = {
  name: "READ_PLUGIN_CONFIG",
  contexts: ["admin", "settings", "connectors"],
  roleGate: { minRole: "OWNER" },

  similes: [
    "GET_PLUGIN_CONFIG",
    "SHOW_PLUGIN_CONFIG",
    "VIEW_PLUGIN_CONFIG",
    "INSPECT_PLUGIN",
    "PLUGIN_CONFIG",
  ],

  description:
    "Return the current configuration and status of a named plugin. " +
    "Shows enabled/configured state, version, and parameter keys (sensitive values masked). " +
    "Read-only — use CONFIGURE_PLUGIN to change settings.",
  descriptionCompressed:
    "return current config status named plugin enabled/configured state, version, param key (sensitive mask) read-only use CONFIGURE_PLUGIN change",

  validate: async () => true,

  handler: async (_runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters;
    const pluginId =
      typeof params?.pluginId === "string" ? params.pluginId.trim() : "";
    const name =
      typeof params?.name === "string" ? params.name.trim() : "";

    const searchTerm = pluginId || name;
    if (!searchTerm) {
      return {
        success: false,
        text: "READ_PLUGIN_CONFIG requires a pluginId or name parameter.",
      };
    }

    try {
      const resp = await fetch(`${getApiBase()}/api/plugins`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        return {
          success: false,
          text: `Failed to fetch plugins list: HTTP ${resp.status}`,
        };
      }
      const data = (await resp.json()) as PluginsListResponse;
      const plugins = data.plugins ?? [];

      // Match by exact id, then by id/name contains search term
      const lower = searchTerm.toLowerCase();
      const plugin =
        plugins.find((p) => p.id === searchTerm) ??
        plugins.find(
          (p) =>
            p.id.toLowerCase().includes(lower) ||
            p.name.toLowerCase().includes(lower),
        );

      if (!plugin) {
        return {
          success: false,
          text: `Plugin "${searchTerm}" not found. Use LIST_INSTALLED_PLUGINS to see available plugins.`,
          values: { error: "NOT_FOUND" },
          data: { actionName: "READ_PLUGIN_CONFIG", searchTerm },
        };
      }

      // Build a human-readable summary
      const lines: string[] = [
        `Plugin: ${plugin.name} (${plugin.id})`,
        `Status: ${plugin.enabled ? "enabled" : "disabled"} | configured: ${plugin.configured}`,
      ];
      if (plugin.version) lines.push(`Version: ${plugin.version}`);
      if (plugin.description) lines.push(`Description: ${plugin.description}`);
      if (plugin.loadError) lines.push(`Load error: ${plugin.loadError}`);

      if (plugin.parameters && plugin.parameters.length > 0) {
        lines.push("\nParameters:");
        for (const param of plugin.parameters) {
          const required = param.required ? " [required]" : "";
          const sensitive = param.sensitive ? " [sensitive]" : "";
          const setValue = param.isSet
            ? param.sensitive
              ? " = ***"
              : ` = ${param.currentValue ?? "(empty)"}`
            : " (not set)";
          lines.push(`  ${param.key}${required}${sensitive}${setValue}`);
        }
      } else if (plugin.configKeys && plugin.configKeys.length > 0) {
        lines.push(`\nConfig keys: ${plugin.configKeys.join(", ")}`);
      }

      return {
        success: true,
        text: lines.join("\n"),
        values: {
          pluginId: plugin.id,
          enabled: plugin.enabled,
          configured: plugin.configured,
        },
        data: {
          actionName: "READ_PLUGIN_CONFIG",
          plugin: {
            id: plugin.id,
            name: plugin.name,
            description: plugin.description,
            enabled: plugin.enabled,
            configured: plugin.configured,
            version: plugin.version ?? null,
            loadError: plugin.loadError ?? null,
            parameters: (plugin.parameters ?? []).map((p) => ({
              key: p.key,
              required: p.required ?? false,
              sensitive: p.sensitive ?? false,
              isSet: p.isSet ?? false,
              // Mask sensitive current values
              currentValue: p.sensitive ? null : (p.currentValue ?? null),
            })),
          },
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[read-plugin-config] error: ${msg}`);
      return {
        success: false,
        text: `Failed to read plugin config: ${msg}`,
      };
    }
  },

  parameters: [
    {
      name: "pluginId",
      description:
        "The plugin id to read (e.g. 'discord', '@elizaos/plugin-discord'). Preferred over name.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "name",
      description: "Plugin name substring to search for (fallback if id not provided).",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Show me the discord plugin config.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Plugin: Discord (@elizaos/plugin-discord)\nStatus: enabled | configured: true\nParameters:\n  DISCORD_API_TOKEN [required] [sensitive] = ***",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "What settings does the openai plugin have?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Plugin: OpenAI (@elizaos/plugin-openai)\nStatus: disabled | configured: false\nParameters:\n  OPENAI_API_KEY [required] [sensitive] (not set)",
        },
      },
    ],
  ] as ActionExample[][],
};
