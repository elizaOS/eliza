/**
 * `/api/connectors` route handler: lists configured connectors (merging
 * eliza.json entries with those detected from env vars), upserts a connector
 * config (POST), and removes one (DELETE /:name). Config writes are persisted
 * through saveElizaConfig with in-memory rollback if the disk write throws, so a
 * failed save never reports success. Disconnects may notify an optional host
 * callback. Blocked object keys are rejected to prevent prototype pollution.
 */
import type http from "node:http";
import type { IAgentRuntime, ReadJsonBodyOptions } from "@elizaos/core";
import { PostConnectorRequestSchema } from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.ts";
import { CONNECTOR_ENV_MAP } from "../config/env-vars.ts";
import type { ConnectorConfig } from "../config/types.eliza.ts";

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
    /** Optional running agent used to report host callback failures. */
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
  /**
   * Fail-closed companion to `cloneWithoutBlockedObjectKeys`. The clone throws
   * the walk-budget error rather than returning a partial object, so callers
   * must run this first and reject; otherwise the error escapes to the route
   * kernel and becomes a 500.
   */
  hasBlockedObjectKeyDeep: (value: unknown) => boolean;
  cloneWithoutBlockedObjectKeys: <T>(value: T) => T;
  /** Optional host-supplied callback fired on every disconnect path. */
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
    hasBlockedObjectKeyDeep,
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
    const rawBody = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawBody === null) return true;
    const parsed = PostConnectorRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      error(
        res,
        parsed.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const { name: connectorName, config } = parsed.data;
    if (hasBlockedObjectKeyDeep(config)) {
      error(res, "Connector config contains a blocked object key", 400);
      return true;
    }
    if (!state.config.connectors) state.config.connectors = {};
    const previousConnector = state.config.connectors[connectorName];
    state.config.connectors[connectorName] = cloneWithoutBlockedObjectKeys(
      config,
    ) as ConnectorConfig;
    try {
      saveElizaConfig(state.config);
    } catch (err) {
      if (previousConnector === undefined) {
        delete state.config.connectors[connectorName];
      } else {
        state.config.connectors[connectorName] = previousConnector;
      }
      error(
        res,
        err instanceof Error
          ? `Failed to save connector config: ${err.message}`
          : "Failed to save connector config",
        500,
      );
      return true;
    }
    // Treat this POST as a disconnect only when the incoming payload explicitly
    // sets `enabled: false`. Inspecting the post-write config value instead
    // would fire on every config-only update that omits `enabled` while the
    // connector is active, wrongly purging live connectors.
    const isDisconnect = (config as ConnectorConfig).enabled === false;
    if (isDisconnect) {
      if (onConnectorDisconnect) {
        try {
          await onConnectorDisconnect(connectorName);
        } catch (err) {
          // error-policy:#14415 — host cache-invalidation callback failed; report
          // rather than swallow so the stale-cache risk is observable.
          state.runtime?.reportError("connector.disconnect.hostCallback", err, {
            connector: connectorName,
            op: "POST-disconnect",
          });
        }
      }
    }
    json(res, {
      connectors: redactConfigSecrets(
        state.config.connectors as Record<string, unknown>,
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
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      // error-policy:J3 untrusted-input sanitizing — malformed percent-encoding is invalid client input
      error(res, "Invalid connector name encoding", 400);
      return true;
    }
    if (!name || isBlockedObjectKey(name)) {
      error(res, "Missing or invalid connector name", 400);
      return true;
    }
    const previousConnector =
      state.config.connectors && Object.hasOwn(state.config.connectors, name)
        ? state.config.connectors[name]
        : undefined;
    if (previousConnector !== undefined) delete state.config.connectors?.[name];
    const stateConfigRecord = state.config as Record<string, unknown>;
    const channels =
      stateConfigRecord.channels &&
      typeof stateConfigRecord.channels === "object"
        ? (stateConfigRecord.channels as Record<string, unknown>)
        : undefined;
    const previousChannel =
      channels && Object.hasOwn(channels, name) ? channels[name] : undefined;
    if (channels && previousChannel !== undefined) {
      delete channels[name];
    }

    try {
      saveElizaConfig(state.config);
    } catch (err) {
      if (previousConnector !== undefined && state.config.connectors) {
        state.config.connectors[name] = previousConnector;
      }
      if (previousChannel !== undefined && channels) {
        channels[name] = previousChannel;
      }
      error(
        res,
        err instanceof Error
          ? `Failed to save connector config: ${err.message}`
          : "Failed to save connector config",
        500,
      );
      return true;
    }
    if (onConnectorDisconnect) {
      try {
        await onConnectorDisconnect(name);
      } catch (err) {
        // error-policy:#14415 — host cache-invalidation callback failed; report.
        state.runtime?.reportError("connector.disconnect.hostCallback", err, {
          connector: name,
          op: "DELETE",
        });
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
