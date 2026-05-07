/**
 * TOGGLE_CONNECTOR / SAVE_CONNECTOR_CONFIG / DISCONNECT_CONNECTOR /
 * LIST_CONNECTORS — connector lifecycle actions for the dashboard's
 * Connectors page.
 *
 * Connectors are plugins with `category === "connector"` (see
 * packages/app-core/src/api/plugins-compat-routes.ts). The toggle and
 * config-save operations reuse the same /api/plugins/{id} PUT endpoint
 * the dashboard hits in PluginsView.
 *
 * `DISCONNECT_CONNECTOR` routes to the per-connector disconnect endpoint
 * exposed by some connectors (telegram-account, discord-local, signal,
 * whatsapp). For connectors without a dedicated disconnect endpoint, the
 * action falls back to clearing the plugin's config so credentials are
 * forgotten.
 *
 * @module actions/connector-control
 */

import type { Action, ActionExample, HandlerOptions } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { resolveServerOnlyPort } from "@elizaos/shared";
import { hasOwnerAccess } from "../security/access.js";

function getApiBase(): string {
  const port = resolveServerOnlyPort(process.env);
  return `http://localhost:${port}`;
}

interface PluginInfoShape {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  configured?: boolean;
  category?: string;
  isActive?: boolean;
}

interface PluginMutationResponse {
  ok?: boolean;
  success?: boolean;
  requiresRestart?: boolean;
  message?: string;
  error?: string;
}

interface GetPluginsResponse {
  plugins?: PluginInfoShape[];
}

interface ListConnectorsParams {
  status?: "enabled" | "disabled" | "active" | "inactive";
  configured?: boolean;
  search?: string;
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

async function fetchConnectors(base: string): Promise<PluginInfoShape[]> {
  const resp = await fetch(`${base}/api/plugins`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    throw new Error(`/api/plugins returned ${resp.status}`);
  }
  const data = (await resp.json()) as GetPluginsResponse;
  const plugins = Array.isArray(data.plugins) ? data.plugins : [];
  return plugins.filter((p) => p.category === "connector");
}

// ---------------------------------------------------------------------------
// TOGGLE_CONNECTOR
// ---------------------------------------------------------------------------

export const toggleConnectorAction: Action = {
  name: "TOGGLE_CONNECTOR",
  contexts: ["connectors", "settings", "admin"],
  roleGate: { minRole: "OWNER" },

  similes: [
    "ENABLE_CONNECTOR",
    "DISABLE_CONNECTOR",
    "FLIP_CONNECTOR",
    "ACTIVATE_CONNECTOR",
  ],

  description:
    "Enable or disable a connector (a plugin in the 'connector' category, " +
    "such as discord, telegram, slack). Pass enabled=true to turn it on " +
    "and enabled=false to turn it off.",
  descriptionCompressed:
    "enable disable connector (plugin connector category, discord, telegram, slack) pass enabl true turn enabl false turn off",

  validate: async (runtime, message) => {
    return hasOwnerAccess(runtime, message);
  },

  handler: async (runtime, message, _state, options) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        success: false,
        text: "Permission denied: only the owner may toggle connectors.",
      };
    }

    const params = (options as HandlerOptions | undefined)?.parameters;
    const connectorId =
      typeof params?.connectorId === "string" ? params.connectorId.trim() : "";
    const enabled =
      typeof params?.enabled === "boolean" ? params.enabled : undefined;

    if (!connectorId) {
      return { success: false, text: "I need a connectorId to toggle." };
    }
    if (typeof enabled !== "boolean") {
      return {
        success: false,
        text: "I need to know whether to enable (true) or disable (false) the connector.",
      };
    }

    try {
      const base = getApiBase();
      const resp = await fetch(
        `${base}/api/plugins/${encodeURIComponent(connectorId)}`,
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
        logger.warn(`[connector-control] toggle ${errMsg}`);
        return {
          success: false,
          text: `Failed to ${enabled ? "enable" : "disable"} ${connectorId}: ${errMsg}`,
        };
      }

      const restartNote = data.requiresRestart
        ? " The agent will restart to apply the change."
        : "";
      return {
        success: true,
        text: `Connector ${connectorId} ${enabled ? "enabled" : "disabled"}.${restartNote}`,
        data: { connectorId, enabled, ...data },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[connector-control] toggle error: ${msg}`);
      return {
        success: false,
        text: `Failed to toggle ${connectorId}: ${msg}`,
      };
    }
  },

  parameters: [
    {
      name: "connectorId",
      description:
        "The connector ID to toggle (e.g. 'discord', 'telegram', 'slack').",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "enabled",
      description: "true to enable the connector, false to disable it.",
      required: true,
      schema: { type: "boolean" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Disable the telegram connector." },
      },
      {
        name: "{{agentName}}",
        content: { text: "Connector telegram disabled." },
      },
    ],
  ] as ActionExample[][],
};

// ---------------------------------------------------------------------------
// SAVE_CONNECTOR_CONFIG
// ---------------------------------------------------------------------------

export const saveConnectorConfigAction: Action = {
  name: "SAVE_CONNECTOR_CONFIG",
  contexts: ["connectors", "settings", "secrets", "admin"],
  roleGate: { minRole: "OWNER" },

  similes: [
    "CONFIGURE_CONNECTOR",
    "SET_CONNECTOR_CONFIG",
    "UPDATE_CONNECTOR_CONFIG",
    "CONNECTOR_SETTINGS",
  ],

  description:
    "Save connector configuration (API keys, tokens, endpoints) and run an " +
    "automatic connection test. Use when the user provides credentials for " +
    "a connector like Discord, Telegram, or Slack.",
  descriptionCompressed:
    "save connector configuration (API key, token, endpoint) run automatic connection test use user provide credential connector like Discord, Telegram, Slack",

  validate: async (runtime, message) => {
    return hasOwnerAccess(runtime, message);
  },

  handler: async (runtime, message, _state, options) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        success: false,
        text: "Permission denied: only the owner may configure connectors.",
      };
    }

    const params = (options as HandlerOptions | undefined)?.parameters;
    const connectorId =
      typeof params?.connectorId === "string" ? params.connectorId.trim() : "";
    const config = normalizeConfig(params?.config);

    if (!connectorId) {
      return { success: false, text: "I need a connectorId to configure." };
    }
    if (!config || Object.keys(config).length === 0) {
      return {
        success: false,
        text: "I need a non-empty config object (key/value pairs) to save.",
      };
    }

    try {
      const base = getApiBase();
      const saveResp = await fetch(
        `${base}/api/plugins/${encodeURIComponent(connectorId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config }),
          signal: AbortSignal.timeout(60_000),
        },
      );
      const saveData = (await saveResp
        .json()
        .catch(() => ({}))) as PluginMutationResponse;

      if (!saveResp.ok || saveData.success === false || saveData.ok === false) {
        const errMsg =
          saveData.error ||
          saveData.message ||
          `Save failed (${saveResp.status}).`;
        logger.warn(`[connector-control] save ${errMsg}`);
        return {
          success: false,
          text: `Failed to save ${connectorId} config: ${errMsg}`,
        };
      }

      const updatedKeys = Object.keys(config).sort().join(", ");
      const restartNote = saveData.requiresRestart
        ? " The agent will restart to apply the change."
        : "";

      // Auto-test the connection after save.
      let testSummary = "";
      try {
        const testResp = await fetch(
          `${base}/api/plugins/${encodeURIComponent(connectorId)}/test`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(30_000),
          },
        );
        const testData = (await testResp.json().catch(() => ({}))) as {
          success?: boolean;
          message?: string;
          error?: string;
          durationMs?: number;
        };
        if (testResp.ok && testData.success) {
          testSummary = ` Connection test passed (${testData.durationMs ?? 0}ms).`;
        } else if (testResp.ok && testData.success === false) {
          testSummary = ` Connection test failed: ${testData.error ?? "unknown"}.`;
        }
      } catch (testErr) {
        testSummary = ` Connection test skipped: ${
          testErr instanceof Error ? testErr.message : "unknown error"
        }.`;
      }

      return {
        success: true,
        text: `Updated ${connectorId} config (${updatedKeys}).${restartNote}${testSummary}`,
        data: { connectorId, updatedKeys: Object.keys(config), ...saveData },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[connector-control] save error: ${msg}`);
      return {
        success: false,
        text: `Failed to save ${connectorId} config: ${msg}`,
      };
    }
  },

  parameters: [
    {
      name: "connectorId",
      description:
        "The connector ID to configure (e.g. 'discord', 'telegram', 'slack').",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "config",
      description:
        "Object of key/value strings to save. Keys are connector parameter names (DISCORD_API_TOKEN, TELEGRAM_BOT_TOKEN, etc.).",
      required: true,
      schema: { type: "object" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Save my discord bot token: xyz.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Updated discord config (DISCORD_API_TOKEN). Connection test passed (412ms).",
        },
      },
    ],
  ] as ActionExample[][],
};

// ---------------------------------------------------------------------------
// DISCONNECT_CONNECTOR
//
// Routes to a connector-specific disconnect endpoint where one exists.
// Falls back to disabling the plugin (which clears the runtime sender) when
// no dedicated endpoint is available.
// ---------------------------------------------------------------------------

const CONNECTOR_DISCONNECT_PATHS: Record<string, string> = {
  telegram: "/api/telegram-account/disconnect",
  "telegram-account": "/api/telegram-account/disconnect",
  whatsapp: "/api/whatsapp/disconnect",
  signal: "/api/signal/disconnect",
  "discord-local": "/api/discord-local/disconnect",
};

export const disconnectConnectorAction: Action = {
  name: "DISCONNECT_CONNECTOR",
  contexts: ["connectors", "settings", "secrets", "admin"],
  roleGate: { minRole: "OWNER" },

  similes: [
    "LOGOUT_CONNECTOR",
    "SIGN_OUT_CONNECTOR",
    "DEAUTH_CONNECTOR",
    "RESET_CONNECTOR",
    "UNLINK_CONNECTOR",
  ],

  description:
    "Disconnect a connector — sign out of the account, drop its session " +
    "credentials, and stop its sender. Routes to the connector-specific " +
    "disconnect endpoint when available, otherwise disables the plugin.",
  descriptionCompressed:
    "disconnect connector sign account, drop session credential, stop sender route connector-specific disconnect endpoint available, otherwise disable plugin",

  validate: async (runtime, message) => {
    return hasOwnerAccess(runtime, message);
  },

  handler: async (runtime, message, _state, options) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        success: false,
        text: "Permission denied: only the owner may disconnect connectors.",
      };
    }

    const params = (options as HandlerOptions | undefined)?.parameters;
    const connectorId =
      typeof params?.connectorId === "string" ? params.connectorId.trim() : "";
    if (!connectorId) {
      return { success: false, text: "I need a connectorId to disconnect." };
    }

    const base = getApiBase();
    const dedicatedPath = CONNECTOR_DISCONNECT_PATHS[connectorId.toLowerCase()];

    if (dedicatedPath) {
      try {
        const resp = await fetch(`${base}${dedicatedPath}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(30_000),
        });
        const data = (await resp.json().catch(() => ({}))) as {
          ok?: boolean;
          success?: boolean;
          message?: string;
          error?: string;
        };
        if (!resp.ok || data.ok === false || data.success === false) {
          const errMsg =
            data.error || data.message || `Disconnect failed (${resp.status}).`;
          logger.warn(`[connector-control] disconnect ${errMsg}`);
          return {
            success: false,
            text: `Failed to disconnect ${connectorId}: ${errMsg}`,
          };
        }
        return {
          success: true,
          text: data.message ?? `Disconnected ${connectorId}.`,
          data: { connectorId, endpoint: dedicatedPath, ...data },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[connector-control] disconnect error: ${msg}`);
        return {
          success: false,
          text: `Failed to disconnect ${connectorId}: ${msg}`,
        };
      }
    }

    // Fallback: disable the plugin so its sender stops.
    try {
      const resp = await fetch(
        `${base}/api/plugins/${encodeURIComponent(connectorId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
          signal: AbortSignal.timeout(60_000),
        },
      );
      const data = (await resp
        .json()
        .catch(() => ({}))) as PluginMutationResponse;
      if (!resp.ok || data.success === false || data.ok === false) {
        const errMsg =
          data.error || data.message || `Disconnect failed (${resp.status}).`;
        return {
          success: false,
          text: `Failed to disconnect ${connectorId}: ${errMsg}`,
        };
      }
      const restartNote = data.requiresRestart
        ? " The agent will restart to drop the session."
        : "";
      return {
        success: true,
        text: `Disconnected ${connectorId} by disabling the connector.${restartNote}`,
        data: { connectorId, fallback: "plugin-disable", ...data },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[connector-control] disconnect fallback error: ${msg}`);
      return {
        success: false,
        text: `Failed to disconnect ${connectorId}: ${msg}`,
      };
    }
  },

  parameters: [
    {
      name: "connectorId",
      description:
        "The connector ID to disconnect (e.g. 'telegram', 'discord-local', 'whatsapp', 'signal').",
      required: true,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Sign out of telegram." },
      },
      {
        name: "{{agentName}}",
        content: { text: "Disconnected telegram." },
      },
    ],
  ] as ActionExample[][],
};

// ---------------------------------------------------------------------------
// LIST_CONNECTORS
// ---------------------------------------------------------------------------

export const listConnectorsAction: Action = {
  name: "LIST_CONNECTORS",
  contexts: ["connectors", "settings", "admin"],
  roleGate: { minRole: "OWNER" },

  similes: [
    "SHOW_CONNECTORS",
    "ENUMERATE_CONNECTORS",
    "WHICH_CONNECTORS",
    "CONNECTOR_STATUS",
  ],

  description:
    "List the connectors known to this agent (plugins in the 'connector' " +
    "category) and their enabled/active state.",
  descriptionCompressed:
    "list connector known agent (plugin connector category) enabled/active state",

  validate: async (runtime, message) => {
    return hasOwnerAccess(runtime, message);
  },

  handler: async (runtime, message, _state, options) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        success: false,
        text: "Permission denied: only the owner may list connectors.",
      };
    }

    try {
      const base = getApiBase();
      const params = (options as HandlerOptions | undefined)?.parameters as
        | ListConnectorsParams
        | undefined;
      const search = params?.search?.trim().toLowerCase() ?? "";
      const connectors = (await fetchConnectors(base)).filter((connector) => {
        if (search) {
          const haystack =
            `${connector.id} ${connector.name} ${connector.description ?? ""}`.toLowerCase();
          if (!haystack.includes(search)) return false;
        }
        if (typeof params?.configured === "boolean") {
          if (Boolean(connector.configured) !== params.configured) return false;
        }
        switch (params?.status) {
          case "enabled":
            return connector.enabled;
          case "disabled":
            return !connector.enabled;
          case "active":
            return Boolean(connector.isActive);
          case "inactive":
            return !connector.isActive;
          default:
            return true;
        }
      });

      if (connectors.length === 0) {
        return {
          success: true,
          text: "No connectors are registered.",
          data: { count: 0, connectors: [] },
        };
      }

      const lines = connectors.map((connector) => {
        const status = connector.enabled ? "enabled" : "disabled";
        const active = connector.isActive ? " active" : "";
        const configured = connector.configured
          ? " configured"
          : " unconfigured";
        return `- ${connector.name} [${connector.id}] (${status}${active},${configured})`;
      });

      return {
        success: true,
        text: [`Connectors (${connectors.length}):`, ...lines].join("\n"),
        data: { count: connectors.length, connectors, filters: params ?? {} },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[connector-control] list error: ${msg}`);
      return { success: false, text: `Failed to list connectors: ${msg}` };
    }
  },

  parameters: [
    {
      name: "status",
      description: "Optional connector status filter.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["enabled", "disabled", "active", "inactive"],
      },
    },
    {
      name: "configured",
      description:
        "When set, include only configured or unconfigured connectors.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "search",
      description:
        "Optional case-insensitive connector name, id, or description filter.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Which connectors are set up?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Connectors (2):\n- Discord [discord] (enabled active, configured)\n- Telegram [telegram] (disabled, unconfigured)",
        },
      },
    ],
  ] as ActionExample[][],
};
