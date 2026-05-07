/**
 * CONFIGURE_PLUGIN — save configuration values for a plugin.
 *
 * Mirrors PluginsView's `handlePluginConfigSave`, which calls
 * `client.updatePlugin(pluginId, { config })` (PUT /api/plugins/{id}).
 *
 * @module actions/configure-plugin
 */

import type { Action, ActionExample, HandlerOptions } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { resolveServerOnlyPort } from "@elizaos/shared";
import { hasOwnerAccess } from "../security/access.js";

function getApiBase(): string {
  const port = resolveServerOnlyPort(process.env);
  return `http://localhost:${port}`;
}

interface PluginMutationResponse {
  ok?: boolean;
  success?: boolean;
  requiresRestart?: boolean;
  message?: string;
  error?: string;
}

function normalizeConfig(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== "string" || key.length === 0) continue;
    if (typeof raw === "string") {
      out[key] = raw;
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      out[key] = String(raw);
    }
  }
  return out;
}

export const configurePluginAction: Action = {
  name: "CONFIGURE_PLUGIN",
  contexts: ["admin", "settings", "connectors", "secrets"],
  roleGate: { minRole: "OWNER" },

  similes: [
    "SAVE_PLUGIN_CONFIG",
    "SET_PLUGIN_CONFIG",
    "UPDATE_PLUGIN_CONFIG",
    "PLUGIN_SETTINGS",
  ],

  description:
    "Save configuration values (e.g. API keys, endpoints, secrets) for an " +
    "installed plugin. Use when the user provides credentials or settings " +
    "that the plugin needs.",
  descriptionCompressed:
    "save configuration value (e g API key, endpoint, secret) install plugin use user provide credential setting plugin need",

  validate: async (runtime, message) => {
    return hasOwnerAccess(runtime, message);
  },

  handler: async (runtime, message, _state, options) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        success: false,
        text: "Permission denied: only the owner may configure plugins.",
      };
    }

    const params = (options as HandlerOptions | undefined)?.parameters;
    const pluginId =
      typeof params?.pluginId === "string" ? params.pluginId.trim() : "";
    const config = normalizeConfig(params?.config);

    if (!pluginId) {
      return { success: false, text: "I need a plugin ID to configure." };
    }
    if (!config) {
      return {
        success: false,
        text: "I need a config object (key/value pairs) to save.",
      };
    }
    if (Object.keys(config).length === 0) {
      return { success: false, text: "Config object was empty." };
    }

    try {
      const base = getApiBase();
      const resp = await fetch(
        `${base}/api/plugins/${encodeURIComponent(pluginId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config }),
          signal: AbortSignal.timeout(60_000),
        },
      );

      const data = (await resp
        .json()
        .catch(() => ({}))) as PluginMutationResponse;

      if (!resp.ok || data.success === false || data.ok === false) {
        const errMsg =
          data.error || data.message || `Save failed (${resp.status}).`;
        logger.warn(`[configure-plugin] ${errMsg}`);
        return {
          success: false,
          text: `Failed to save config for ${pluginId}: ${errMsg}`,
        };
      }

      const restartNote = data.requiresRestart
        ? " The agent will restart to apply the change."
        : "";
      const updatedKeys = Object.keys(config).sort().join(", ");
      return {
        success: true,
        text: `Updated ${pluginId} config (${updatedKeys}).${restartNote}`,
        data: { pluginId, updatedKeys: Object.keys(config), ...data },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[configure-plugin] error: ${msg}`);
      return {
        success: false,
        text: `Failed to save config for ${pluginId}: ${msg}`,
      };
    }
  },

  parameters: [
    {
      name: "pluginId",
      description:
        "The plugin ID to configure (e.g. 'discord', '@elizaos/plugin-discord').",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "config",
      description:
        "Object of key/value strings to save. Keys are plugin parameter names; values are their new settings.",
      required: true,
      schema: { type: "object" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Set the discord bot token to xyz.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Updated discord config (DISCORD_API_TOKEN). The agent will restart to apply the change.",
        },
      },
    ],
  ] as ActionExample[][],
};
