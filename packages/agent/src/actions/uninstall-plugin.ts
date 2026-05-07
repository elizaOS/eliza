/**
 * UNINSTALL_PLUGIN — remove a plugin from the runtime.
 *
 * Posts to /api/plugins/uninstall via the server. Mirrors the dashboard's
 * uninstall handler in PluginsView, which calls
 * `client.uninstallRegistryPlugin()`.
 *
 * @module actions/uninstall-plugin
 */

import type { Action, ActionExample, HandlerOptions } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { resolveServerOnlyPort } from "@elizaos/shared";

function getApiBase(): string {
  const port = resolveServerOnlyPort(process.env);
  return `http://localhost:${port}`;
}

interface PluginUninstallResponse {
  success?: boolean;
  pluginName?: string;
  requiresRestart?: boolean;
  message?: string;
  error?: string;
}

export const uninstallPluginAction: Action = {
  name: "UNINSTALL_PLUGIN",
  contexts: ["admin", "settings", "connectors"],
  roleGate: { minRole: "OWNER" },

  similes: ["REMOVE_PLUGIN", "DELETE_PLUGIN", "DROP_PLUGIN", "PURGE_PLUGIN"],

  description:
    "Uninstall a plugin from this agent. Removes the plugin package and " +
    "may trigger a restart so the runtime drops it. Use when the user asks " +
    "to remove, delete, or uninstall a plugin.",
  descriptionCompressed:
    "uninstall plugin agent remove plugin package trigger restart runtime drop use user ask remove, delete, uninstall plugin",

  validate: async () => true,

  handler: async (_runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters;
    const pluginId =
      typeof params?.pluginId === "string" ? params.pluginId.trim() : "";

    if (!pluginId) {
      return { success: false, text: "I need a plugin ID to uninstall." };
    }

    const npmName = pluginId.startsWith("@")
      ? pluginId
      : `@elizaos/plugin-${pluginId}`;

    try {
      const base = getApiBase();
      const resp = await fetch(`${base}/api/plugins/uninstall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: npmName, autoRestart: true }),
        signal: AbortSignal.timeout(120_000),
      });

      const data = (await resp
        .json()
        .catch(() => ({}))) as PluginUninstallResponse;

      if (!resp.ok || data.success === false) {
        const errMsg =
          data.error || data.message || `Uninstall failed (${resp.status}).`;
        logger.warn(`[uninstall-plugin] ${errMsg}`);
        return {
          success: false,
          text: `Failed to uninstall ${pluginId}: ${errMsg}`,
        };
      }

      const name = data.pluginName ?? npmName;
      const restartNote = data.requiresRestart
        ? " The agent will restart to drop it."
        : "";
      return {
        success: true,
        text: `Plugin ${name} uninstalled successfully.${restartNote}`,
        data: { pluginId, npmName, ...data },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[uninstall-plugin] error: ${msg}`);
      return { success: false, text: `Uninstall failed: ${msg}` };
    }
  },

  parameters: [
    {
      name: "pluginId",
      description:
        "The short plugin ID or npm package to uninstall (e.g. 'telegram' or '@elizaos/plugin-telegram').",
      required: true,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Uninstall the telegram plugin." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Plugin @elizaos/plugin-telegram uninstalled successfully. The agent will restart to drop it.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Drop the OpenAI integration." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Plugin @elizaos/plugin-openai uninstalled successfully. The agent will restart to drop it.",
        },
      },
    ],
  ] as ActionExample[][],
};
