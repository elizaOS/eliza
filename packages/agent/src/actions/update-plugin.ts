/**
 * UPDATE_PLUGIN — fetch the latest version of an installed plugin.
 *
 * Mirrors `client.updateRegistryPlugin()` (POST /api/plugins/update).
 *
 * @module actions/update-plugin
 */

import type { Action, ActionExample, HandlerOptions } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { resolveServerOnlyPort } from "@elizaos/shared";
import { hasOwnerAccess } from "../security/access.js";

function getApiBase(): string {
  const port = resolveServerOnlyPort(process.env);
  return `http://localhost:${port}`;
}

type ReleaseStream = "latest" | "beta";

function isReleaseStream(value: unknown): value is ReleaseStream {
  return value === "latest" || value === "beta";
}

interface PluginUpdateResponse {
  success?: boolean;
  pluginName?: string;
  version?: string;
  requiresRestart?: boolean;
  message?: string;
  error?: string;
}

export const updatePluginAction: Action = {
  name: "UPDATE_PLUGIN",
  contexts: ["admin", "settings", "connectors"],
  roleGate: { minRole: "OWNER" },

  similes: [
    "UPGRADE_PLUGIN",
    "REFRESH_PLUGIN",
    "PULL_PLUGIN_UPDATE",
    "BUMP_PLUGIN",
  ],

  description:
    "Update an installed plugin to the latest available version. Pass " +
    "stream='beta' to take the beta release instead of the stable one.",
  descriptionCompressed:
    "update install plugin latest available version pass stream beta take beta release instead stable one",

  validate: async (runtime, message) => {
    return hasOwnerAccess(runtime, message);
  },

  handler: async (runtime, message, _state, options) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        success: false,
        text: "Permission denied: only the owner may update plugins.",
      };
    }

    const params = (options as HandlerOptions | undefined)?.parameters;
    const pluginId =
      typeof params?.pluginId === "string" ? params.pluginId.trim() : "";
    const stream: ReleaseStream | undefined = isReleaseStream(params?.stream)
      ? params.stream
      : undefined;

    if (!pluginId) {
      return { success: false, text: "I need a plugin ID to update." };
    }

    const npmName = pluginId.startsWith("@")
      ? pluginId
      : `@elizaos/plugin-${pluginId}`;

    try {
      const base = getApiBase();
      const body: Record<string, unknown> = {
        name: npmName,
        autoRestart: true,
      };
      if (stream) body.stream = stream;

      const resp = await fetch(`${base}/api/plugins/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });

      const data = (await resp
        .json()
        .catch(() => ({}))) as PluginUpdateResponse;

      if (!resp.ok || data.success === false) {
        const errMsg =
          data.error || data.message || `Update failed (${resp.status}).`;
        logger.warn(`[update-plugin] ${errMsg}`);
        return {
          success: false,
          text: `Failed to update ${pluginId}: ${errMsg}`,
        };
      }

      const name = data.pluginName ?? npmName;
      const ver = data.version ? `@${data.version}` : "";
      const restartNote = data.requiresRestart
        ? " The agent will restart to load the new version."
        : "";
      return {
        success: true,
        text: `Plugin ${name}${ver} updated successfully.${restartNote}`,
        data: { pluginId, npmName, stream, ...data },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[update-plugin] error: ${msg}`);
      return { success: false, text: `Update failed: ${msg}` };
    }
  },

  parameters: [
    {
      name: "pluginId",
      description:
        "The plugin ID or npm package to update (e.g. 'telegram' or '@elizaos/plugin-telegram').",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "stream",
      description:
        "Release stream to pull from: 'latest' (stable) or 'beta'. Defaults to the plugin's current stream.",
      required: false,
      schema: { type: "string" as const, enum: ["latest", "beta"] },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Update the discord plugin." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Plugin @elizaos/plugin-discord@1.5.0 updated successfully. The agent will restart to load the new version.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Bump telegram to beta." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Plugin @elizaos/plugin-telegram@2.0.0-beta.0 updated successfully.",
        },
      },
    ],
  ] as ActionExample[][],
};
