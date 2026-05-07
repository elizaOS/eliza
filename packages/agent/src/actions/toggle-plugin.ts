/**
 * TOGGLE_PLUGIN — enable or disable an installed plugin.
 *
 * Mirrors PluginsView's `handleTogglePlugin`, which calls
 * `client.updatePlugin(pluginId, { enabled })` (PUT /api/plugins/{id}).
 *
 * @module actions/toggle-plugin
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

export const togglePluginAction: Action = {
  name: "TOGGLE_PLUGIN",
  contexts: ["admin", "settings", "connectors"],
  roleGate: { minRole: "OWNER" },

  similes: [
    "ENABLE_PLUGIN_TOGGLE",
    "DISABLE_PLUGIN",
    "FLIP_PLUGIN",
    "ACTIVATE_PLUGIN",
    "DEACTIVATE_PLUGIN",
  ],

  description:
    "Enable or disable an already-installed plugin. Use this when the user " +
    "asks to turn a plugin on or off without uninstalling it. Pass " +
    "enabled=true to enable, enabled=false to disable.",
  descriptionCompressed:
    "enable disable already-install plugin use user ask turn plugin off wo/ uninstall pass enabl true enable, enabl false disable",

  validate: async (runtime, message) => {
    return hasOwnerAccess(runtime, message);
  },

  handler: async (runtime, message, _state, options) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        success: false,
        text: "Permission denied: only the owner may toggle plugins.",
      };
    }

    const params = (options as HandlerOptions | undefined)?.parameters;
    const pluginId =
      typeof params?.pluginId === "string" ? params.pluginId.trim() : "";
    const enabled =
      typeof params?.enabled === "boolean" ? params.enabled : undefined;

    if (!pluginId) {
      return { success: false, text: "I need a plugin ID to toggle." };
    }
    if (typeof enabled !== "boolean") {
      return {
        success: false,
        text: "I need to know whether to enable (true) or disable (false) the plugin.",
      };
    }

    try {
      const base = getApiBase();
      const resp = await fetch(
        `${base}/api/plugins/${encodeURIComponent(pluginId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
          signal: AbortSignal.timeout(60_000),
        },
      );

      const data = (await resp
        .json()
        .catch(() => ({}))) as PluginMutationResponse;

      if (!resp.ok || data.success === false || data.ok === false) {
        const errMsg =
          data.error || data.message || `Toggle failed (${resp.status}).`;
        logger.warn(`[toggle-plugin] ${errMsg}`);
        return {
          success: false,
          text: `Failed to ${enabled ? "enable" : "disable"} ${pluginId}: ${errMsg}`,
        };
      }

      const restartNote = data.requiresRestart
        ? " The agent will restart to apply the change."
        : "";
      return {
        success: true,
        text: `Plugin ${pluginId} ${enabled ? "enabled" : "disabled"}.${restartNote}`,
        data: { pluginId, enabled, ...data },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[toggle-plugin] error: ${msg}`);
      return {
        success: false,
        text: `Failed to toggle ${pluginId}: ${msg}`,
      };
    }
  },

  parameters: [
    {
      name: "pluginId",
      description:
        "The plugin ID to toggle (e.g. 'discord', '@elizaos/plugin-discord').",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "enabled",
      description: "true to enable the plugin, false to disable it.",
      required: true,
      schema: { type: "boolean" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Disable the discord plugin for now." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Plugin discord disabled. The agent will restart to apply the change.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Turn the telegram plugin back on." },
      },
      {
        name: "{{agentName}}",
        content: { text: "Plugin telegram enabled." },
      },
    ],
  ] as ActionExample[][],
};
