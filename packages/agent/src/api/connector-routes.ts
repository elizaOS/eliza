import type http from "node:http";
import type { ElizaConfig } from "../config/config.js";
import type { ConnectorConfig } from "../config/types.eliza.js";
import type { ReadJsonBodyOptions } from "./http-helpers.js";

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
  } = ctx;

  // ── GET /api/connectors ──────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/connectors") {
    const connectors =
      state.config.connectors ??
      (state.config as Record<string, unknown>).channels ??
      {};
    json(res, {
      connectors: redactConfigSecrets(connectors as Record<string, unknown>),
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
    json(res, {
      connectors: redactConfigSecrets(
        (state.config.connectors ?? {}) as Record<string, unknown>,
      ),
    });
    return true;
  }

  // ── DELETE /api/connectors/:name ─────────────────────────────────────
  if (method === "DELETE" && pathname.startsWith("/api/connectors/")) {
    const name = decodeURIComponent(pathname.slice("/api/connectors/".length));
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
    json(res, {
      connectors: redactConfigSecrets(
        (state.config.connectors ?? {}) as Record<string, unknown>,
      ),
    });
    return true;
  }

  return false;
}
