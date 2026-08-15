/**
 * HTTP handler for /api/mcp/* on the host server: marketplace search/details
 * (proxying registry.modelcontextprotocol.io), config CRUD over
 * settings.mcp.servers, and runtime connection status. The host injects a
 * McpRouteContext supplying request/response helpers plus config-security guards
 * (prototype-pollution key blocking, stdio terminal authorization, per-server
 * validation); stdio config changes require terminal authorization and a restart.
 */
import type http from "node:http";
import { logger, type ReadJsonBodyOptions } from "@elizaos/core";
import { getMcpServerDetails, searchMcpMarketplace } from "./mcp-marketplace.js";
import { MCP_SERVICE_NAME } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  state: {
    config: McpRouteConfig;
    runtime: { getService: (name: string) => unknown } | null;
  };
  json: (res: http.ServerResponse, data: unknown, status?: number) => void | Promise<void>;
  error: (res: http.ServerResponse, message: string, status?: number) => void | Promise<void>;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions
  ) => Promise<T | null>;
  saveElizaConfig: (config: McpRouteConfig) => void;
  redactDeep: (val: unknown) => unknown;
  isBlockedObjectKey: (key: string) => boolean;
  cloneWithoutBlockedObjectKeys: <T>(value: T) => T;
  resolveMcpServersRejection: (servers: Record<string, unknown>) => Promise<string | null>;
  resolveMcpTerminalAuthorizationRejection: (
    req: http.IncomingMessage,
    servers: Record<string, unknown>,
    body: { terminalToken?: string }
  ) => { reason: string; status: number } | null;
  decodePathComponent: (raw: string, res: http.ServerResponse, label: string) => string | null;
}

type McpConfigServer = Record<string, unknown> & {
  type: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  cwd?: string;
  timeoutInMillis?: number;
};

export interface McpRouteConfig {
  mcp?: {
    servers?: Record<string, McpConfigServer>;
  };
}

interface ParseClampedIntegerOptions {
  min?: number;
  max?: number;
  fallback?: number;
}

const MCP_MARKETPLACE_QUERY_MAX_LENGTH = 200;
const MCP_MARKETPLACE_SERVER_NAME_MAX_LENGTH = 200;
const MCP_MARKETPLACE_DETAILS_PREFIX = "/api/mcp/marketplace/details/";
const MCP_MARKETPLACE_DIRECT_DETAILS_PREFIX = "/api/mcp/marketplace/";

interface RequestAbortTracker {
  signal: AbortSignal;
  isAborted: () => boolean;
  markCompleted: () => void;
  dispose: () => void;
}

type AbortEventSource = {
  on?: (event: string, listener: () => void) => unknown;
  off?: (event: string, listener: () => void) => unknown;
};

function createRequestAbortTracker(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  operation: string
): RequestAbortTracker {
  const controller = new AbortController();
  const registrations: Array<{
    source: AbortEventSource;
    event: string;
    listener: () => void;
  }> = [];
  let completed = false;

  const abort = () => {
    if (!completed && !controller.signal.aborted) {
      controller.abort(new Error(`${operation} client disconnected`));
    }
  };
  const register = (
    source: AbortEventSource | null | undefined,
    event: string,
    listener: () => void
  ) => {
    if (typeof source?.on !== "function") return;
    source.on(event, listener);
    registrations.push({ source, event, listener });
  };
  const onResponseClose = () => {
    if (!res.writableEnded) abort();
  };

  register(req, "aborted", abort);
  register(req, "error", abort);
  register(res, "close", onResponseClose);
  register(res, "error", abort);
  register(req.socket, "close", abort);
  register(req.socket, "error", abort);

  if (req.aborted || req.destroyed || res.destroyed) abort();

  return {
    signal: controller.signal,
    isAborted: () => controller.signal.aborted,
    markCompleted: () => {
      completed = true;
    },
    dispose: () => {
      for (const { source, event, listener } of registrations) {
        source.off?.(event, listener);
      }
      registrations.length = 0;
    },
  };
}

function parseClampedInteger(
  value: string | null | undefined,
  options: ParseClampedIntegerOptions = {}
): number | undefined {
  const raw = value == null ? "" : value.trim();
  if (!raw) return Number.isFinite(options.fallback) ? options.fallback : undefined;

  if (!/^[+-]?\d+$/.test(raw)) {
    return Number.isFinite(options.fallback) ? options.fallback : undefined;
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    return Number.isFinite(options.fallback) ? options.fallback : undefined;
  }

  if (options.min !== undefined && parsed < options.min) return options.min;
  if (options.max !== undefined && parsed > options.max) return options.max;
  return parsed;
}

function normalizeBoundedString(value: string, maxLength: number, label: string): string {
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new RangeError(`${label} must be ${maxLength} characters or fewer`);
  }
  return normalized;
}

function canWriteMarketplaceResponse(res: http.ServerResponse): boolean {
  return !res.destroyed && !res.writableEnded;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleMcpRoutes(ctx: McpRouteContext): Promise<boolean> {
  const { req, res, method, pathname, url, state, json, error, readJsonBody } = ctx;

  // ═══════════════════════════════════════════════════════════════════════
  // MCP marketplace routes
  // ═══════════════════════════════════════════════════════════════════════

  if (method === "GET" && pathname === "/api/mcp/marketplace/search") {
    let query: string;
    // error-policy:J1 route input failures are translated to a 400 response.
    try {
      query = normalizeBoundedString(
        url.searchParams.get("q") ?? "",
        MCP_MARKETPLACE_QUERY_MAX_LENGTH,
        "Marketplace search query"
      );
    } catch (err) {
      error(res, err instanceof Error ? err.message : String(err), 400);
      return true;
    }
    const limitStr = url.searchParams.get("limit");
    const limit = limitStr ? parseClampedInteger(limitStr, { min: 1, max: 50, fallback: 30 }) : 30;
    const abortTracker = createRequestAbortTracker(req, res, "MCP marketplace search");
    // error-policy:J1 marketplace boundary failures are translated to a 502 response.
    try {
      const result = await searchMcpMarketplace(query || undefined, limit, {
        signal: abortTracker.signal,
      });
      if (abortTracker.isAborted() || !canWriteMarketplaceResponse(res)) return true;
      await json(res, { ok: true, results: result.results });
      abortTracker.markCompleted();
    } catch (err) {
      if (abortTracker.isAborted() || !canWriteMarketplaceResponse(res)) return true;
      await error(
        res,
        `MCP marketplace search failed: ${err instanceof Error ? err.message : err}`,
        502
      );
      abortTracker.markCompleted();
    } finally {
      abortTracker.dispose();
    }
    return true;
  }

  const marketplaceDetailsPrefix = pathname.startsWith(MCP_MARKETPLACE_DETAILS_PREFIX)
    ? MCP_MARKETPLACE_DETAILS_PREFIX
    : pathname.startsWith(MCP_MARKETPLACE_DIRECT_DETAILS_PREFIX)
      ? MCP_MARKETPLACE_DIRECT_DETAILS_PREFIX
      : null;
  if (method === "GET" && marketplaceDetailsPrefix) {
    const serverName = ctx.decodePathComponent(
      pathname.slice(marketplaceDetailsPrefix.length),
      res,
      "server name"
    );
    if (serverName === null) return true;
    let normalizedServerName: string;
    // error-policy:J1 route input failures are translated to a 400 response.
    try {
      normalizedServerName = normalizeBoundedString(
        serverName,
        MCP_MARKETPLACE_SERVER_NAME_MAX_LENGTH,
        "Server name"
      );
    } catch (err) {
      error(res, err instanceof Error ? err.message : String(err), 400);
      return true;
    }
    if (!normalizedServerName) {
      error(res, "Server name is required", 400);
      return true;
    }
    const abortTracker = createRequestAbortTracker(req, res, "MCP marketplace details");
    // error-policy:J1 marketplace boundary failures are translated to a 502 response.
    try {
      const details = await getMcpServerDetails(normalizedServerName, {
        signal: abortTracker.signal,
      });
      if (abortTracker.isAborted() || !canWriteMarketplaceResponse(res)) return true;
      if (!details) {
        await error(res, `MCP server "${normalizedServerName}" not found`, 404);
        abortTracker.markCompleted();
        return true;
      }
      await json(res, { ok: true, server: details });
      abortTracker.markCompleted();
    } catch (err) {
      if (abortTracker.isAborted() || !canWriteMarketplaceResponse(res)) return true;
      await error(
        res,
        `Failed to fetch server details: ${err instanceof Error ? err.message : err}`,
        502
      );
      abortTracker.markCompleted();
    } finally {
      abortTracker.dispose();
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MCP config routes
  // ═══════════════════════════════════════════════════════════════════════

  if (method === "GET" && pathname === "/api/mcp/config") {
    const servers = state.config.mcp?.servers ?? {};
    json(res, { ok: true, servers: ctx.redactDeep(servers) });
    return true;
  }

  if (method === "POST" && pathname === "/api/mcp/config/server") {
    const body = await readJsonBody<{
      name?: string;
      config?: Record<string, unknown>;
      terminalToken?: string;
    }>(req, res);
    if (!body) return true;

    const serverName = (body.name as string | undefined)?.trim();
    if (!serverName) {
      error(res, "Server name is required", 400);
      return true;
    }
    if (ctx.isBlockedObjectKey(serverName)) {
      error(
        res,
        'Invalid server name: "__proto__", "constructor", and "prototype" are reserved',
        400
      );
      return true;
    }

    const config = body.config as Record<string, unknown> | undefined;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      error(res, "Server config object is required", 400);
      return true;
    }

    const mcpRejection = await ctx.resolveMcpServersRejection({
      [serverName]: config,
    });
    if (mcpRejection) {
      error(res, mcpRejection, 400);
      return true;
    }

    const mcpTerminalRejection = ctx.resolveMcpTerminalAuthorizationRejection(
      req,
      { [serverName]: config },
      body
    );
    if (mcpTerminalRejection) {
      error(
        res,
        `Configuring stdio MCP servers requires terminal authorization. ${mcpTerminalRejection.reason}`,
        mcpTerminalRejection.status
      );
      return true;
    }

    if (!state.config.mcp) state.config.mcp = {};
    if (!state.config.mcp.servers) state.config.mcp.servers = {};
    const sanitized = ctx.cloneWithoutBlockedObjectKeys(config);
    state.config.mcp.servers[serverName] = sanitized as NonNullable<
      NonNullable<typeof state.config.mcp>["servers"]
    >[string];

    // error-policy:J4 a config write failure is visible in logs while the in-memory update remains usable.
    try {
      ctx.saveElizaConfig(state.config);
    } catch (err) {
      logger.warn(`[api] Config save failed: ${err instanceof Error ? err.message : err}`);
    }

    json(res, { ok: true, name: serverName, requiresRestart: true });
    return true;
  }

  if (method === "DELETE" && pathname.startsWith("/api/mcp/config/server/")) {
    const serverName = ctx.decodePathComponent(
      pathname.slice("/api/mcp/config/server/".length),
      res,
      "server name"
    );
    if (serverName === null) return true;
    if (ctx.isBlockedObjectKey(serverName)) {
      error(
        res,
        'Invalid server name: "__proto__", "constructor", and "prototype" are reserved',
        400
      );
      return true;
    }

    if (state.config.mcp?.servers?.[serverName]) {
      delete state.config.mcp.servers[serverName];
      // error-policy:J4 a config write failure is visible in logs while the in-memory update remains usable.
      try {
        ctx.saveElizaConfig(state.config);
      } catch (err) {
        logger.warn(`[api] Config save failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    json(res, { ok: true, requiresRestart: true });
    return true;
  }

  if (method === "PUT" && pathname === "/api/mcp/config") {
    const body = await readJsonBody<{
      servers?: Record<string, unknown>;
      terminalToken?: string;
    }>(req, res);
    if (!body) return true;

    if (!state.config.mcp) state.config.mcp = {};
    if (body.servers !== undefined) {
      if (!body.servers || typeof body.servers !== "object" || Array.isArray(body.servers)) {
        error(res, "servers must be a JSON object", 400);
        return true;
      }
      for (const serverName of Object.keys(body.servers)) {
        if (ctx.isBlockedObjectKey(serverName)) {
          error(
            res,
            'Invalid server name: "__proto__", "constructor", and "prototype" are reserved',
            400
          );
          return true;
        }
      }
      const mcpRejection = await ctx.resolveMcpServersRejection(
        body.servers as Record<string, unknown>
      );
      if (mcpRejection) {
        error(res, mcpRejection, 400);
        return true;
      }
      const mcpTerminalRejection = ctx.resolveMcpTerminalAuthorizationRejection(
        req,
        body.servers as Record<string, unknown>,
        body
      );
      if (mcpTerminalRejection) {
        error(
          res,
          `Configuring stdio MCP servers requires terminal authorization. ${mcpTerminalRejection.reason}`,
          mcpTerminalRejection.status
        );
        return true;
      }
      const sanitized = ctx.cloneWithoutBlockedObjectKeys(body.servers);
      state.config.mcp.servers = sanitized as NonNullable<
        NonNullable<typeof state.config.mcp>["servers"]
      >;
    }

    // error-policy:J4 a config write failure is visible in logs while the in-memory update remains usable.
    try {
      ctx.saveElizaConfig(state.config);
    } catch (err) {
      logger.warn(`[api] Config save failed: ${err instanceof Error ? err.message : err}`);
    }

    json(res, { ok: true });
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MCP status route
  // ═══════════════════════════════════════════════════════════════════════

  if (method === "GET" && pathname === "/api/mcp/status") {
    const servers: Array<{
      name: string;
      status: string;
      toolCount: number;
      resourceCount: number;
    }> = [];

    if (state.runtime) {
      // error-policy:J4 service lookup failure degrades to an empty status response.
      try {
        const mcpService = state.runtime.getService(MCP_SERVICE_NAME) as {
          getServers?: () => Array<{
            name: string;
            status: string;
            tools?: unknown[];
            resources?: unknown[];
          }>;
        } | null;
        if (mcpService && typeof mcpService.getServers === "function") {
          for (const s of mcpService.getServers()) {
            servers.push({
              name: s.name,
              status: s.status,
              toolCount: Array.isArray(s.tools) ? s.tools.length : 0,
              resourceCount: Array.isArray(s.resources) ? s.resources.length : 0,
            });
          }
        }
      } catch (err) {
        logger.debug(`[api] Service not available: ${err instanceof Error ? err.message : err}`);
      }
    }

    json(res, { ok: true, servers });
    return true;
  }

  return false;
}
