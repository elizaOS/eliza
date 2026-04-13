/**
 * INSTALL_PLUGIN action — installs a plugin from the registry.
 *
 * When triggered the action:
 *   1. Extracts the plugin ID from the parameters
 *   2. POSTs to the local API server to install it
 *   3. The agent automatically restarts to load the new plugin
 *   4. Returns a status message
 *
 * @module actions/install-plugin
 */

import type { Action, HandlerOptions } from "@elizaos/core";
import { resolveDesktopApiPort } from "@elizaos/shared/runtime-env";
import {
  ensurePluginManagerAllowed,
  getPluginManagerBlockReason,
  PLUGIN_MANAGER_UNAVAILABLE_ERROR,
} from "../runtime/plugin-manager-guard";

/** API port for posting install requests. */
const API_PORT = String(resolveDesktopApiPort(process.env));

type InstallPluginResponse = {
  ok: boolean;
  message?: string;
  error?: string;
};

function parseInstallPluginResponse(value: unknown): InstallPluginResponse {
  if (!value || typeof value !== "object") {
    return { ok: false, error: "Invalid install response" };
  }

  const record = value as Record<string, unknown>;
  return {
    ok: record.ok === true,
    message: typeof record.message === "string" ? record.message : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
  };
}

async function postInstallRequest(npmName: string): Promise<Response> {
  return fetch(`http://localhost:${API_PORT}/api/plugins/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: npmName, autoRestart: true }),
  });
}

async function restartAgent(): Promise<void> {
  const response = await fetch(
    `http://localhost:${API_PORT}/api/agent/restart`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  if (!response.ok) {
    const body = parseInstallPluginResponse(
      await response.json().catch(() => null),
    );
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
}

export const installPluginAction: Action = {
  name: "INSTALL_PLUGIN",

  similes: [
    "INSTALL",
    "ADD_PLUGIN",
    "ENABLE_PLUGIN",
    "SETUP_PLUGIN",
    "GET_PLUGIN",
  ],

  description:
    "Install a plugin that is not yet installed. Use this when a user asks to " +
    "use, enable, set up, or install a plugin that is marked [available] " +
    "(not yet loaded). The plugin will be downloaded and the agent will " +
    "restart to load it.",

  validate: async () => true,

  handler: async (_runtime, _message, _state, options) => {
    try {
      const params = (options as HandlerOptions | undefined)?.parameters;
      const pluginId =
        typeof params?.pluginId === "string"
          ? params.pluginId.trim()
          : undefined;

      if (!pluginId) {
        return { text: "I need a plugin ID to install.", success: false };
      }

      // The API expects the full npm package name
      const npmName = pluginId.startsWith("@")
        ? pluginId
        : `@elizaos/plugin-${pluginId}`;
      const pluginManagerGuard = await ensurePluginManagerAllowed();
      const pluginManagerBlockReason =
        getPluginManagerBlockReason(pluginManagerGuard);
      if (pluginManagerBlockReason) {
        return {
          text: `Failed to install ${pluginId}: ${pluginManagerBlockReason}`,
          success: false,
        };
      }
      let restartedForPluginManager = false;
      if (pluginManagerGuard === "enabled") {
        await restartAgent();
        restartedForPluginManager = true;
      }

      let response = await postInstallRequest(npmName);

      if (!response.ok) {
        let body = parseInstallPluginResponse(
          await response.json().catch(() => null),
        );
        if ((body.error ?? "").includes(PLUGIN_MANAGER_UNAVAILABLE_ERROR)) {
          const recoveryGuard = await ensurePluginManagerAllowed();
          const recoveryBlockReason =
            getPluginManagerBlockReason(recoveryGuard);
          if (recoveryBlockReason) {
            return {
              text: `Failed to install ${pluginId}: ${recoveryBlockReason}`,
              success: false,
            };
          }
          if (!restartedForPluginManager) {
            await restartAgent();
            restartedForPluginManager = true;
          }
          response = await postInstallRequest(npmName);
          body = parseInstallPluginResponse(
            await response.json().catch(() => null),
          );
        }
        if (!response.ok) {
          return {
            text: `Failed to install ${pluginId}: ${body.error ?? `HTTP ${response.status}`}`,
            success: false,
          };
        }
        const result = body;
        if (!result.ok) {
          return {
            text: `Failed to install ${pluginId}: ${result.error ?? "unknown error"}`,
            success: false,
          };
        }
        return {
          text:
            result.message ??
            `Plugin ${pluginId} installed successfully. The agent is restarting to load it.`,
          success: true,
          data: { pluginId, npmName },
        };
      }

      const result = parseInstallPluginResponse(await response.json());

      if (!result.ok) {
        return {
          text: `Failed to install ${pluginId}: ${result.error ?? "unknown error"}`,
          success: false,
        };
      }

      return {
        text:
          result.message ??
          `Plugin ${pluginId} installed successfully. The agent is restarting to load it.`,
        success: true,
        data: { pluginId, npmName },
      };
    } catch (err) {
      return {
        text: `Install failed: ${err instanceof Error ? err.message : String(err)}`,
        success: false,
      };
    }
  },

  parameters: [
    {
      name: "pluginId",
      description:
        "The short plugin ID to install (e.g. 'telegram', 'discord', 'polymarket')",
      required: true,
      schema: { type: "string" as const },
    },
  ],
};
