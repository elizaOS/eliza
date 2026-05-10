import type http from "node:http";
import type {
  EventPayload,
  IAgentRuntime,
  ReadJsonBodyOptions,
} from "@elizaos/core";
import { credTypesForConnector } from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.ts";
import { CONNECTOR_ENV_MAP } from "../config/env-vars.ts";
import type { ConnectorConfig } from "../config/types.eliza.ts";

/**
 * Runtime event name emitted when a connector is disconnected. Subscribers
 * (e.g. `WorkflowCredentialStore` in `@elizaos/plugin-workflow`) self-purge
 * any caches keyed off the connector instead of the agent reaching across
 * package boundaries to call them directly.
 *
 * Kept as a local string constant to avoid pulling plugin-workflow types
 * into the agent. The matching constant in plugin-workflow lives at
 * `plugins/plugin-workflow/src/types/index.ts` (`CONNECTOR_DISCONNECTED_EVENT`).
 */
const CONNECTOR_DISCONNECTED_EVENT = "connector_disconnected";

interface ConnectorDisconnectedPayload extends EventPayload {
  userId: string;
  credTypes: readonly string[];
  connectorName: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConnectorRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  state: {
    config: ElizaConfig;
    /**
     * Optional running agent. When present, every disconnect path emits
     * `connector_disconnected` so service-owned caches (workflow credential
     * store, etc.) self-invalidate without the agent reaching across package
     * boundaries.
     */
    runtime?: IAgentRuntime | null;
  };
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  saveElizaConfig: (config: ElizaConfig) => void;
  redactConfigSecrets: (
    config: Record<string, unknown>,
  ) => Record<string, unknown>;
  isBlockedObjectKey: (key: string) => boolean;
  cloneWithoutBlockedObjectKeys: <T>(value: T) => T;
  /**
   * Optional host-supplied callback fired on every disconnect path. The
   * canonical invalidation channel is the `connector_disconnected` runtime
   * event (subscribed to by services like the workflow credential store);
   * this callback remains as a host extension point for behavior that does
   * not belong on the runtime event bus.
   */
  onConnectorDisconnect?: (connectorName: string) => Promise<void> | void;
}

/**
 * Emit the `connector_disconnected` runtime event so service subscribers can
 * purge their own caches. Safe when no runtime / no subscribers are
 * registered: the runtime emit is a no-op in that case.
 */
async function emitConnectorDisconnected(
  runtime: IAgentRuntime | null | undefined,
  connectorName: string,
): Promise<void> {
  if (!runtime) return;
  const credTypes = credTypesForConnector(connectorName);
  const payload: ConnectorDisconnectedPayload = {
    runtime,
    userId: runtime.agentId,
    credTypes,
    connectorName,
  };
  await runtime.emitEvent(CONNECTOR_DISCONNECTED_EVENT, payload);
}

function getConfiguredConnectorsFromEnv(): Record<
  string,
  { enabled: true; configuredViaEnv: true }
> {
  const configured: Record<string, { enabled: true; configuredViaEnv: true }> =
    {};

  for (const [connectorName, envMap] of Object.entries(CONNECTOR_ENV_MAP)) {
    const envKeys = new Set(Object.values(envMap));
    if (connectorName === "discord") {
      envKeys.add("DISCORD_BOT_TOKEN");
    }

    const hasAnyEnvValue = [...envKeys].some((envKey) => {
      const value = process.env[envKey];
      return typeof value === "string" && value.trim().length > 0;
    });

    if (hasAnyEnvValue) {
      configured[connectorName] = {
        enabled: true,
        configuredViaEnv: true,
      };
    }
  }

  return configured;
}

function listVisibleConnectors(config: ElizaConfig): Record<string, unknown> {
  const rawConnectors =
    config.connectors ??
    ((config as Record<string, unknown>).channels as
      | Record<string, unknown>
      | undefined) ??
    {};
  const visibleConnectors =
    rawConnectors &&
    typeof rawConnectors === "object" &&
    !Array.isArray(rawConnectors)
      ? { ...rawConnectors }
      : {};

  for (const [connectorName, summary] of Object.entries(
    getConfiguredConnectorsFromEnv(),
  )) {
    if (!(connectorName in visibleConnectors)) {
      visibleConnectors[connectorName] = summary;
    }
  }

  return visibleConnectors;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleConnectorRoutes(
  ctx: ConnectorRouteContext,
): Promise<boolean> {
  const {
    req,
    res,
    method,
    pathname,
    state,
    json,
    error,
    readJsonBody,
    saveElizaConfig,
    redactConfigSecrets,
    isBlockedObjectKey,
    cloneWithoutBlockedObjectKeys,
    onConnectorDisconnect,
  } = ctx;

  // ── GET /api/connectors ──────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/connectors") {
    json(res, {
      connectors: redactConfigSecrets(listVisibleConnectors(state.config)),
    });
    return true;
  }

  // ── POST /api/connectors ─────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/connectors") {
    const body = await readJsonBody(req, res);
    if (!body) return true;
    const name = (body as Record<string, unknown>).name;
    const config = (body as Record<string, unknown>).config;
    if (!name || typeof name !== "string" || !(name as string).trim()) {
      error(res, "Missing connector name", 400);
      return true;
    }
    const connectorName = (name as string).trim();
    if (isBlockedObjectKey(connectorName)) {
      error(
        res,
        'Invalid connector name: "__proto__", "constructor", and "prototype" are reserved',
        400,
      );
      return true;
    }
    if (!config || typeof config !== "object") {
      error(res, "Missing connector config", 400);
      return true;
    }
    if (!state.config.connectors) state.config.connectors = {};
    state.config.connectors[connectorName] = cloneWithoutBlockedObjectKeys(
      config,
    ) as ConnectorConfig;
    try {
      saveElizaConfig(state.config);
    } catch {
      /* test envs */
    }
    // Only treat this POST as a disconnect when the incoming payload
    // explicitly sets `enabled: false`. The second clause that read
    // `state.config.connectors[connectorName]` would have been evaluated
    // AFTER the new (cloned) config was written above, making it equivalent
    // to checking the incoming payload — but firing on every config-only
    // update that happens to omit `enabled` while the connector was active.
    // That false-positive purge silently broke live connectors.
    const isDisconnect = (config as ConnectorConfig).enabled === false;
    if (isDisconnect) {
      try {
        await emitConnectorDisconnected(state.runtime, connectorName);
      } catch {
        /* don't let event-bus failure block the response */
      }
      if (onConnectorDisconnect) {
        try {
          await onConnectorDisconnect(connectorName);
        } catch {
          /* don't let host callback failure block the response */
        }
      }
    }
    json(res, {
      connectors: redactConfigSecrets(
        (state.config.connectors ?? {}) as Record<string, unknown>,
      ),
    });
    return true;
  }

  // ── DELETE /api/connectors/:name ─────────────────────────────────────
  if (method === "DELETE" && pathname.startsWith("/api/connectors/")) {
    const rawName = pathname.slice("/api/connectors/".length);
    if (rawName.includes("/")) {
      return false;
    }
    const name = decodeURIComponent(rawName);
    if (!name || isBlockedObjectKey(name)) {
      error(res, "Missing or invalid connector name", 400);
      return true;
    }
    if (
      state.config.connectors &&
      Object.hasOwn(state.config.connectors, name)
    ) {
      delete state.config.connectors[name];
    }
    const stateConfigRecord = state.config as Record<string, unknown>;
    if (
      stateConfigRecord.channels &&
      typeof stateConfigRecord.channels === "object" &&
      Object.hasOwn(stateConfigRecord.channels, name)
    ) {
      delete (stateConfigRecord.channels as Record<string, unknown>)[name];
    }

    try {
      saveElizaConfig(state.config);
    } catch {
      /* test envs */
    }
    try {
      await emitConnectorDisconnected(state.runtime, name);
    } catch {
      /* don't let event-bus failure block the response */
    }
    if (onConnectorDisconnect) {
      try {
        await onConnectorDisconnect(name);
      } catch {
        /* don't let host callback failure block the response */
      }
    }
    json(res, {
      connectors: redactConfigSecrets(
        (state.config.connectors ?? {}) as Record<string, unknown>,
      ),
    });
    return true;
  }

  return false;
}
