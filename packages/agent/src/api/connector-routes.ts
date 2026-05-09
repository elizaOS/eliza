import type http from "node:http";
import type { ElizaConfig } from "../config/config.js";
import { CONNECTOR_ENV_MAP } from "../config/env-vars.js";
import type { ConnectorConfig } from "../config/types.eliza.js";
import type { ReadJsonBodyOptions } from "@elizaos/shared";

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
   * Called when a connector is disconnected (POST `/api/connectors` with
   * `enabled: false`) or DELETE-d. Lets the host purge service-owned caches
   * keyed off the connector — most importantly the n8n credential cache,
   * which would otherwise return stale ids and silently bypass the
   * missing-credentials banner.
   */
  onConnectorDisconnect?: (connectorName: string) => Promise<void> | void;
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
    if (isDisconnect && onConnectorDisconnect) {
      try {
        await onConnectorDisconnect(connectorName);
      } catch {
        /* don't let cache-purge failure block the response */
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
    if (onConnectorDisconnect) {
      try {
        await onConnectorDisconnect(name);
      } catch {
        /* don't let cache-purge failure block the response */
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
