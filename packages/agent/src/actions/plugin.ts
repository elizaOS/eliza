/**
 * PLUGIN — consolidated plugin + connector lifecycle action.
 *
 * Single polymorphic action dispatching across:
 *   install | uninstall | update | sync | eject | reinject |
 *   configure | read_config | toggle | list | disconnect
 *
 * `type` (`plugin` | `connector`) disambiguates plugin vs connector lifecycle
 * for the planner. Connectors are plugins with `category === "connector"` and
 * reuse the same /api/plugins compat routes. The `disconnect` op routes to a
 * connector-specific disconnect endpoint when one exists (telegram, signal,
 * whatsapp, discord-local) and falls back to disabling the plugin otherwise.
 *
 * Internal services > HTTP. install / uninstall / update / sync / eject /
 * reinject all delegate to PluginManagerService via runtime.getService().
 * The configure / read_config / toggle / list / disconnect ops fall through
 * to the existing /api/plugins compat routes because their orchestration
 * (vault mirror, runtime mutation, drift reconciliation) lives in
 * `@elizaos/app-core`, which is an outer layer the agent package cannot
 * import from.
 *
 * NOTE: `MANAGE_PLUGINS` in `@elizaos/core/features/plugin-manager` and
 * `CONNECTOR` in `@elizaos/app-lifeops` remain as separate actions for now.
 * Folding them in requires absorbing core multi-turn create state and
 * LifeOps-specific dispatch (Google OAuth, Telegram pairing, etc.).
 * Tracked in ACTION_CONSOLIDATION_PLAN.md §3d.
 *
 * @module actions/plugin
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { requestRestart, resolveServerOnlyPort } from "@elizaos/shared";
import {
  isPluginManagerLike,
  type PluginManagerLike,
} from "../services/plugin-manager-types.ts";

const PLUGIN_OPS = [
  "install",
  "uninstall",
  "update",
  "sync",
  "eject",
  "reinject",
  "configure",
  "read_config",
  "toggle",
  "list",
  "disconnect",
] as const;
type PluginOp = (typeof PLUGIN_OPS)[number];

const PLUGIN_TYPES = ["plugin", "connector"] as const;
type PluginType = (typeof PLUGIN_TYPES)[number];

const RELEASE_STREAMS = ["latest", "beta"] as const;
type ReleaseStream = (typeof RELEASE_STREAMS)[number];

const LIST_STATUSES = ["enabled", "disabled", "active", "inactive"] as const;
type ListStatus = (typeof LIST_STATUSES)[number];

interface ListFilter {
  status?: ListStatus;
  configured?: boolean;
  search?: string;
}

interface PluginParams {
  action?: PluginOp;
  subaction?: PluginOp;
  op?: PluginOp;
  type?: PluginType;
  pluginId?: string;
  /** Alias for pluginId so connector-style callers keep working. */
  connectorId?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
  stream?: ReleaseStream;
  filter?: ListFilter;
  /** When type=connector or filter is omitted, top-level filter fields work too. */
  status?: ListStatus;
  configured?: boolean;
  search?: string;
}

interface PluginMutationResponse {
  ok?: boolean;
  success?: boolean;
  requiresRestart?: boolean;
  message?: string;
  error?: string;
  pluginName?: string;
  version?: string;
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
  category?: string;
  isActive?: boolean;
}

interface PluginsListResponse {
  plugins: PluginListEntry[];
}

interface DisconnectResponse {
  ok?: boolean;
  success?: boolean;
  message?: string;
  error?: string;
}

const CONNECTOR_DISCONNECT_PATHS: Record<string, string> = {
  telegram: "/api/telegram-account/disconnect",
  "telegram-account": "/api/telegram-account/disconnect",
  whatsapp: "/api/whatsapp/disconnect",
  signal: "/api/signal/disconnect",
  "discord-local": "/api/discord-local/disconnect",
};

function getApiBase(): string {
  const port = resolveServerOnlyPort(process.env);
  return `http://localhost:${port}`;
}

function getPluginManager(runtime: IAgentRuntime): PluginManagerLike | null {
  const svc = runtime.getService("plugin_manager");
  return isPluginManagerLike(svc) ? svc : null;
}

function fail(text: string, error: string): ActionResult {
  return { success: false, text, data: { error } };
}

function normalizeNpmName(pluginId: string): string {
  return pluginId.startsWith("@") ? pluginId : `@elizaos/plugin-${pluginId}`;
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

function resolveTargetId(params: PluginParams): string {
  return params.pluginId?.trim() || params.connectorId?.trim() || "";
}

function resolveListFilter(params: PluginParams): ListFilter {
  if (params.filter && typeof params.filter === "object") {
    return params.filter;
  }
  return {
    status: params.status,
    configured: params.configured,
    search: params.search,
  };
}

// ---------------------------------------------------------------------------
// Op handlers
// ---------------------------------------------------------------------------

async function doInstall(
  mgr: PluginManagerLike,
  params: PluginParams,
): Promise<ActionResult> {
  const pluginId = resolveTargetId(params);
  if (!pluginId) return fail("Missing pluginId.", "PLUGIN_INSTALL_FAILED");

  const npmName = normalizeNpmName(pluginId);
  const result = await mgr.installPlugin(npmName);

  if (!result.success) {
    return fail(
      `Failed to install ${pluginId}: ${result.error ?? "unknown error"}`,
      "PLUGIN_INSTALL_FAILED",
    );
  }

  return {
    success: true,
    text: `Plugin ${result.pluginName}@${result.version} installed successfully.${result.requiresRestart ? " The agent will restart to load it." : ""}`,
    data: { actionName: "PLUGIN", op: "install", pluginId, npmName, ...result },
  };
}

async function doUninstall(
  mgr: PluginManagerLike,
  params: PluginParams,
): Promise<ActionResult> {
  const pluginId = resolveTargetId(params);
  if (!pluginId) return fail("Missing pluginId.", "PLUGIN_UNINSTALL_FAILED");

  const npmName = normalizeNpmName(pluginId);
  const result = await mgr.uninstallPlugin(npmName);

  if (!result.success) {
    return fail(
      `Failed to uninstall ${pluginId}: ${result.error ?? "unknown error"}`,
      "PLUGIN_UNINSTALL_FAILED",
    );
  }

  return {
    success: true,
    text: `Plugin ${result.pluginName} uninstalled successfully.${result.requiresRestart ? " The agent will restart to drop it." : ""}`,
    data: {
      actionName: "PLUGIN",
      op: "uninstall",
      pluginId,
      npmName,
      ...result,
    },
  };
}

async function doUpdate(
  mgr: PluginManagerLike,
  params: PluginParams,
): Promise<ActionResult> {
  const pluginId = resolveTargetId(params);
  if (!pluginId) return fail("Missing pluginId.", "PLUGIN_UPDATE_FAILED");
  if (typeof mgr.updatePlugin !== "function") {
    return fail(
      "Plugin manager does not support updates.",
      "PLUGIN_UPDATE_FAILED",
    );
  }

  const npmName = normalizeNpmName(pluginId);
  const stream = params.stream;
  const options = stream !== undefined ? { releaseStream: stream } : undefined;
  const result = await mgr.updatePlugin(npmName, undefined, options);

  if (!result.success) {
    return fail(
      `Failed to update ${pluginId}: ${result.error ?? "unknown error"}`,
      "PLUGIN_UPDATE_FAILED",
    );
  }

  return {
    success: true,
    text: `Plugin ${result.pluginName}@${result.version} updated successfully.${result.requiresRestart ? " The agent will restart to load the new version." : ""}`,
    data: {
      actionName: "PLUGIN",
      op: "update",
      pluginId,
      npmName,
      stream,
      ...result,
    },
  };
}

async function doSync(
  mgr: PluginManagerLike,
  params: PluginParams,
): Promise<ActionResult> {
  const pluginId = resolveTargetId(params);
  if (!pluginId) return fail("Missing pluginId.", "PLUGIN_SYNC_FAILED");

  const result = await mgr.syncPlugin(pluginId);
  if (!result.success) {
    return fail(
      `Failed to sync ${pluginId}: ${result.error ?? "unknown error"}.`,
      "PLUGIN_SYNC_FAILED",
    );
  }

  return {
    success: true,
    text: `Synced ${result.pluginName}.`,
    data: { actionName: "PLUGIN", op: "sync", pluginId, ...result },
  };
}

async function doEject(
  mgr: PluginManagerLike,
  params: PluginParams,
): Promise<ActionResult> {
  const pluginId = resolveTargetId(params);
  if (!pluginId) return fail("Missing pluginId.", "PLUGIN_EJECT_FAILED");

  const result = await mgr.ejectPlugin(pluginId);
  if (!result.success) {
    return fail(
      `Failed to eject ${pluginId}: ${result.error ?? "unknown error"}`,
      "PLUGIN_EJECT_FAILED",
    );
  }

  setTimeout(() => {
    requestRestart(`Plugin ${result.pluginName} ejected`);
  }, 1_000);

  return {
    success: true,
    text: `Ejected ${result.pluginName} to ${result.ejectedPath}. Restarting to load local source.`,
    data: { actionName: "PLUGIN", op: "eject", pluginId, ...result },
  };
}

async function doReinject(
  mgr: PluginManagerLike,
  params: PluginParams,
): Promise<ActionResult> {
  const pluginId = resolveTargetId(params);
  if (!pluginId) return fail("Missing pluginId.", "PLUGIN_REINJECT_FAILED");

  const result = await mgr.reinjectPlugin(pluginId);
  if (!result.success) {
    return fail(
      `Failed to reinject ${pluginId}: ${result.error ?? "unknown error"}`,
      "PLUGIN_REINJECT_FAILED",
    );
  }

  setTimeout(() => {
    requestRestart(`Plugin ${result.pluginName} reinjected`);
  }, 1_000);

  return {
    success: true,
    text: `Removed ejected plugin ${result.pluginName}. Restarting to load npm version.`,
    data: { actionName: "PLUGIN", op: "reinject", pluginId, ...result },
  };
}

// configure / read_config / toggle: orchestration (vault mirror, runtime
// mutation, drift reconciliation) is in @elizaos/app-core which the agent
// layer cannot import. Hit the local /api/plugins compat routes instead.

async function doConfigure(params: PluginParams): Promise<ActionResult> {
  const pluginId = resolveTargetId(params);
  if (!pluginId) return fail("Missing pluginId.", "PLUGIN_CONFIGURE_FAILED");

  const config = normalizeConfig(params.config);
  if (!config || Object.keys(config).length === 0) {
    return fail("Missing or empty config object.", "PLUGIN_CONFIGURE_FAILED");
  }

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

  const data = (await resp.json().catch(() => ({}))) as PluginMutationResponse;

  if (!resp.ok || data.success === false || data.ok === false) {
    const errMsg =
      data.error || data.message || `Save failed (${resp.status}).`;
    logger.warn(`[plugin:configure] ${errMsg}`);
    return fail(
      `Failed to save config for ${pluginId}: ${errMsg}`,
      "PLUGIN_CONFIGURE_FAILED",
    );
  }

  // Auto-test connection (best-effort, surface result in text).
  let testSummary = "";
  try {
    const testResp = await fetch(
      `${base}/api/plugins/${encodeURIComponent(pluginId)}/test`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30_000),
      },
    );
    const testData = (await testResp.json().catch(() => ({}))) as {
      success?: boolean;
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

  const restartNote = data.requiresRestart
    ? " The agent will restart to apply the change."
    : "";
  const updatedKeys = Object.keys(config).sort().join(", ");

  return {
    success: true,
    text: `Updated ${pluginId} config (${updatedKeys}).${restartNote}${testSummary}`,
    data: {
      actionName: "PLUGIN",
      op: "configure",
      pluginId,
      updatedKeys: Object.keys(config),
      ...data,
    },
  };
}

async function doReadConfig(params: PluginParams): Promise<ActionResult> {
  const pluginId = resolveTargetId(params);
  if (!pluginId) return fail("Missing pluginId.", "PLUGIN_READ_CONFIG_FAILED");

  const base = getApiBase();
  const resp = await fetch(`${base}/api/plugins`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    return fail(
      `Failed to fetch plugins list: HTTP ${resp.status}`,
      "PLUGIN_READ_CONFIG_FAILED",
    );
  }

  const listData = (await resp.json()) as PluginsListResponse;
  const plugins = listData.plugins ?? [];
  const lower = pluginId.toLowerCase();
  const plugin =
    plugins.find((p) => p.id === pluginId) ??
    plugins.find(
      (p) =>
        p.id.toLowerCase().includes(lower) ||
        p.name.toLowerCase().includes(lower),
    );

  if (!plugin) {
    return fail(
      `Plugin "${pluginId}" not found.`,
      "PLUGIN_READ_CONFIG_NOT_FOUND",
    );
  }

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
      actionName: "PLUGIN",
      op: "read_config",
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
          currentValue: p.sensitive ? null : (p.currentValue ?? null),
        })),
      },
    },
  };
}

async function doToggle(params: PluginParams): Promise<ActionResult> {
  const pluginId = resolveTargetId(params);
  if (!pluginId) return fail("Missing pluginId.", "PLUGIN_TOGGLE_FAILED");

  const enabled = params.enabled;
  if (typeof enabled !== "boolean") {
    return fail("Missing 'enabled' boolean parameter.", "PLUGIN_TOGGLE_FAILED");
  }

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

  const data = (await resp.json().catch(() => ({}))) as PluginMutationResponse;

  if (!resp.ok || data.success === false || data.ok === false) {
    const errMsg =
      data.error || data.message || `Toggle failed (${resp.status}).`;
    logger.warn(`[plugin:toggle] ${errMsg}`);
    return fail(
      `Failed to ${enabled ? "enable" : "disable"} ${pluginId}: ${errMsg}`,
      "PLUGIN_TOGGLE_FAILED",
    );
  }

  const restartNote = data.requiresRestart
    ? " The agent will restart to apply the change."
    : "";
  return {
    success: true,
    text: `Plugin ${pluginId} ${enabled ? "enabled" : "disabled"}.${restartNote}`,
    data: {
      actionName: "PLUGIN",
      op: "toggle",
      pluginId,
      enabled,
      ...data,
    },
  };
}

async function fetchPluginsList(base: string): Promise<PluginListEntry[]> {
  const resp = await fetch(`${base}/api/plugins`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    throw new Error(`/api/plugins returned ${resp.status}`);
  }
  const data = (await resp.json()) as PluginsListResponse;
  return Array.isArray(data.plugins) ? data.plugins : [];
}

function applyListFilter(
  entries: PluginListEntry[],
  filter: ListFilter,
): PluginListEntry[] {
  const search = filter.search?.trim().toLowerCase() ?? "";
  return entries.filter((entry) => {
    if (search) {
      const haystack =
        `${entry.id} ${entry.name} ${entry.description ?? ""}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    if (typeof filter.configured === "boolean") {
      if (Boolean(entry.configured) !== filter.configured) return false;
    }
    switch (filter.status) {
      case "enabled":
        return entry.enabled;
      case "disabled":
        return !entry.enabled;
      case "active":
        return Boolean(entry.isActive);
      case "inactive":
        return !entry.isActive;
      default:
        return true;
    }
  });
}

async function doList(params: PluginParams): Promise<ActionResult> {
  const base = getApiBase();
  const filter = resolveListFilter(params);
  const type: PluginType = params.type ?? "connector";

  let entries: PluginListEntry[];
  try {
    entries = await fetchPluginsList(base);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[plugin:list] ${msg}`);
    return fail(`Failed to list ${type}s: ${msg}`, "PLUGIN_LIST_FAILED");
  }

  const scoped =
    type === "connector"
      ? entries.filter((entry) => entry.category === "connector")
      : entries;
  const filtered = applyListFilter(scoped, filter);

  const label = type === "connector" ? "Connectors" : "Plugins";

  if (filtered.length === 0) {
    return {
      success: true,
      text: `No ${type}s match the requested filter.`,
      data: {
        actionName: "PLUGIN",
        op: "list",
        type,
        count: 0,
        entries: [],
      },
    };
  }

  const lines = filtered.map((entry) => {
    const status = entry.enabled ? "enabled" : "disabled";
    const active = entry.isActive ? " active" : "";
    const configured = entry.configured ? " configured" : " unconfigured";
    return `- ${entry.name} [${entry.id}] (${status}${active},${configured})`;
  });

  return {
    success: true,
    text: [`${label} (${filtered.length}):`, ...lines].join("\n"),
    data: {
      actionName: "PLUGIN",
      op: "list",
      type,
      count: filtered.length,
      entries: filtered,
      filter,
    },
  };
}

async function doDisconnect(params: PluginParams): Promise<ActionResult> {
  const connectorId = resolveTargetId(params);
  if (!connectorId)
    return fail("Missing connector id.", "PLUGIN_DISCONNECT_FAILED");

  const base = getApiBase();
  const dedicatedPath = CONNECTOR_DISCONNECT_PATHS[connectorId.toLowerCase()];

  if (dedicatedPath) {
    const resp = await fetch(`${base}${dedicatedPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await resp.json().catch(() => ({}))) as DisconnectResponse;
    if (!resp.ok || data.ok === false || data.success === false) {
      const errMsg =
        data.error || data.message || `Disconnect failed (${resp.status}).`;
      logger.warn(`[plugin:disconnect] ${errMsg}`);
      return fail(
        `Failed to disconnect ${connectorId}: ${errMsg}`,
        "PLUGIN_DISCONNECT_FAILED",
      );
    }
    return {
      success: true,
      text: data.message ?? `Disconnected ${connectorId}.`,
      data: {
        actionName: "PLUGIN",
        op: "disconnect",
        connectorId,
        endpoint: dedicatedPath,
        ...data,
      },
    };
  }

  // Fallback: disable the plugin so its sender stops.
  const resp = await fetch(
    `${base}/api/plugins/${encodeURIComponent(connectorId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
      signal: AbortSignal.timeout(60_000),
    },
  );
  const data = (await resp.json().catch(() => ({}))) as PluginMutationResponse;
  if (!resp.ok || data.success === false || data.ok === false) {
    const errMsg =
      data.error || data.message || `Disconnect failed (${resp.status}).`;
    return fail(
      `Failed to disconnect ${connectorId}: ${errMsg}`,
      "PLUGIN_DISCONNECT_FAILED",
    );
  }
  const restartNote = data.requiresRestart
    ? " The agent will restart to drop the session."
    : "";
  return {
    success: true,
    text: `Disconnected ${connectorId} by disabling the connector.${restartNote}`,
    data: {
      actionName: "PLUGIN",
      op: "disconnect",
      connectorId,
      fallback: "plugin-disable",
      ...data,
    },
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

const PLUGIN_MANAGER_OPS: ReadonlySet<PluginOp> = new Set([
  "install",
  "uninstall",
  "update",
  "sync",
  "eject",
  "reinject",
]);

export const pluginAction: Action = {
  name: "PLUGIN",
  contexts: ["admin", "settings", "connectors", "secrets", "code", "files"],
  roleGate: { minRole: "OWNER" },
  similes: [
    // Old plugin-lifecycle action names
    "INSTALL_PLUGIN",
    "UNINSTALL_PLUGIN",
    "UPDATE_PLUGIN",
    "SYNC_PLUGIN",
    "EJECT_PLUGIN",
    "REINJECT_PLUGIN",
    "CONFIGURE_PLUGIN",
    "READ_PLUGIN_CONFIG",
    "TOGGLE_PLUGIN",
    // Old connector-control action names
    "CONFIGURE_CONNECTOR",
    "SAVE_CONNECTOR_CONFIG",
    "SET_CONNECTOR_ENABLED",
    "TOGGLE_CONNECTOR",
    "DISCONNECT_CONNECTOR",
    "LIST_CONNECTORS",
    // Existing intermediate parent (now folded in)
    "CONNECTOR",
    // Coarse aliases planners may emit
    "PLUGIN_LIFECYCLE",
    "MANAGE_PLUGIN",
    "MANAGE_CONNECTOR",
  ],
  description:
    "Manage plugin and connector lifecycle. ops: install, uninstall, " +
    "update (refresh to latest), sync (pull upstream into ejected source), " +
    "eject (clone source locally), reinject (drop ejected copy and use npm), " +
    "configure (save key/value config + auto-test), read_config (return " +
    "current state), toggle (enable/disable), list (enumerate plugins or " +
    "connectors with optional filter), disconnect (sign out connector and " +
    "drop session). type='plugin' (default) targets installed plugins; " +
    "type='connector' targets plugins in the 'connector' category.",
  descriptionCompressed:
    "manage plugin+connector lifecycle install uninstall update sync eject reinject configure read_config toggle list disconnect type=plugin|connector",
  validate: async (runtime) => getPluginManager(runtime) !== null,
  handler: async (
    runtime: IAgentRuntime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as PluginParams;
    const op = params.action ?? params.subaction ?? params.op;
    if (!op || !PLUGIN_OPS.includes(op)) {
      return fail(
        `action is required and must be one of ${PLUGIN_OPS.join(", ")}.`,
        "PLUGIN_INVALID",
      );
    }

    try {
      if (PLUGIN_MANAGER_OPS.has(op)) {
        const mgr = getPluginManager(runtime);
        if (!mgr) {
          return fail(
            "Plugin manager service is not available.",
            `PLUGIN_${op.toUpperCase()}_FAILED`,
          );
        }
        switch (op) {
          case "install":
            return await doInstall(mgr, params);
          case "uninstall":
            return await doUninstall(mgr, params);
          case "update":
            return await doUpdate(mgr, params);
          case "sync":
            return await doSync(mgr, params);
          case "eject":
            return await doEject(mgr, params);
          case "reinject":
            return await doReinject(mgr, params);
        }
      }

      switch (op) {
        case "configure":
          return await doConfigure(params);
        case "read_config":
          return await doReadConfig(params);
        case "toggle":
          return await doToggle(params);
        case "list":
          return await doList(params);
        case "disconnect":
          return await doDisconnect(params);
      }

      return fail(`Unhandled op '${op}'.`, "PLUGIN_INVALID");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[plugin:${op}] failed: ${msg}`);
      return fail(
        `Failed to ${op}: ${msg}`,
        `PLUGIN_${op.toUpperCase()}_FAILED`,
      );
    }
  },
  parameters: [
    {
      name: "action",
      description: "Operation to perform.",
      required: true,
      schema: { type: "string" as const, enum: [...PLUGIN_OPS] },
    },
    {
      name: "type",
      description:
        "What we are operating on. 'plugin' (default) = any installed plugin; 'connector' = a plugin in the 'connector' category (discord, telegram, slack, etc.).",
      required: false,
      schema: { type: "string" as const, enum: [...PLUGIN_TYPES] },
    },
    {
      name: "pluginId",
      description:
        "Plugin id or npm package (e.g. 'discord' or '@elizaos/plugin-discord'). Required for everything except 'list'.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "connectorId",
      description:
        "Connector id (alias of pluginId; e.g. 'discord', 'telegram', 'whatsapp'). Use this when type=connector.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "config",
      description:
        "configure: object of key/value strings to save. Keys are plugin parameter names; values are their new settings.",
      required: false,
      schema: { type: "object" as const },
    },
    {
      name: "enabled",
      description: "toggle: true to enable, false to disable.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "stream",
      description:
        "update: release stream to pull from ('latest' or 'beta'). Defaults to the plugin's current stream.",
      required: false,
      schema: { type: "string" as const, enum: [...RELEASE_STREAMS] },
    },
    {
      name: "status",
      description:
        "list filter: only return entries with this status (enabled/disabled/active/inactive).",
      required: false,
      schema: { type: "string" as const, enum: [...LIST_STATUSES] },
    },
    {
      name: "configured",
      description:
        "list filter: when true, only configured entries; when false, only unconfigured.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "search",
      description:
        "list filter: case-insensitive substring match against id/name/description.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Install the telegram plugin." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Plugin @elizaos/plugin-telegram@1.4.0 installed successfully. The agent will restart to load it.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Set the discord bot token to xyz." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Updated discord config (DISCORD_API_TOKEN). The agent will restart to apply the change.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Show me the discord plugin config." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Plugin: Discord (@elizaos/plugin-discord)\nStatus: enabled | configured: true",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Disable the discord plugin." },
      },
      {
        name: "{{agentName}}",
        content: { text: "Plugin discord disabled." },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Pull the latest into my forked discord plugin." },
      },
      {
        name: "{{agentName}}",
        content: { text: "Synced @elizaos/plugin-discord." },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Fork the telegram plugin locally." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Ejected @elizaos/plugin-telegram. Restarting to load local source.",
        },
      },
    ],
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
