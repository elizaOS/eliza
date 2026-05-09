import type http from "node:http";
import { logger } from "@elizaos/core";
import type { ElizaConfig } from "../config/config.js";
import {
  getMcpServerDetails,
  searchMcpMarketplace,
} from "../services/mcp-marketplace.js";
import { parseClampedInteger } from "../utils/number-parsing.js";
import type { ReadJsonBodyOptions } from "@elizaos/shared";

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
    config: ElizaConfig;
    runtime: { getService: (name: string) => unknown } | null;
  };
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  saveElizaConfig: (config: ElizaConfig) => void;
  redactDeep: (val: unknown) => unknown;
  isBlockedObjectKey: (key: string) => boolean;
  cloneWithoutBlockedObjectKeys: <T>(value: T) => T;
  resolveMcpServersRejection: (
    servers: Record<string, unknown>,
  ) => Promise<string | null>;
  resolveMcpTerminalAuthorizationRejection: (
    req: http.IncomingMessage,
    servers: Record<string, unknown>,
    body: { terminalToken?: string },
  ) => { reason: string; status: number } | null;
  decodePathComponent: (
    raw: string,
    res: http.ServerResponse,
    label: string,
  ) => string | null;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleMcpRoutes(ctx: McpRouteContext): Promise<boolean> {
  const { req, res, method, pathname, url, state, json, error, readJsonBody } =
    ctx;

  // ═══════════════════════════════════════════════════════════════════════
  // MCP marketplace routes
  // ═══════════════════════════════════════════════════════════════════════

  if (method === "GET" && pathname === "/api/mcp/marketplace/search") {
    const query = url.searchParams.get("q") ?? "";
    const limitStr = url.searchParams.get("limit");
    const limit = limitStr
      ? parseClampedInteger(limitStr, { min: 1, max: 50, fallback: 30 })
      : 30;
    try {
      const result = await searchMcpMarketplace(query || undefined, limit);
      json(res, { ok: true, results: result.results });
    } catch (err) {
      error(
        res,
        `MCP marketplace search failed: ${err instanceof Error ? err.message : err}`,
        502,
      );
    }
    return true;
  }

  if (
    method === "GET" &&
    pathname.startsWith("/api/mcp/marketplace/details/")
  ) {
    const serverName = ctx.decodePathComponent(
      pathname.slice("/api/mcp/marketplace/details/".length),
      res,
      "server name",
    );
    if (serverName === null) return true;
    if (!serverName.trim()) {
      error(res, "Server name is required", 400);
      return true;
    }
    try {
      const details = await getMcpServerDetails(serverName);
      if (!details) {
        error(res, `MCP server "${serverName}" not found`, 404);
        return true;
      }
      json(res, { ok: true, server: details });
    } catch (err) {
      error(
        res,
        `Failed to fetch server details: ${err instanceof Error ? err.message : err}`,
        502,
      );
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
        400,
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
      body,
    );
    if (mcpTerminalRejection) {
      error(
        res,
        `Configuring stdio MCP servers requires terminal authorization. ${mcpTerminalRejection.reason}`,
        mcpTerminalRejection.status,
      );
      return true;
    }

    if (!state.config.mcp) state.config.mcp = {};
    if (!state.config.mcp.servers) state.config.mcp.servers = {};
    const sanitized = ctx.cloneWithoutBlockedObjectKeys(config);
    state.config.mcp.servers[serverName] = sanitized as NonNullable<
      NonNullable<typeof state.config.mcp>["servers"]
    >[string];

    try {
      ctx.saveElizaConfig(state.config);
    } catch (err) {
      logger.warn(
        `[api] Config save failed: ${err instanceof Error ? err.message : err}`,
      );
    }

    json(res, { ok: true, name: serverName, requiresRestart: true });
    return true;
  }

  if (method === "DELETE" && pathname.startsWith("/api/mcp/config/server/")) {
    const serverName = ctx.decodePathComponent(
      pathname.slice("/api/mcp/config/server/".length),
      res,
      "server name",
    );
    if (serverName === null) return true;
    if (ctx.isBlockedObjectKey(serverName)) {
      error(
        res,
        'Invalid server name: "__proto__", "constructor", and "prototype" are reserved',
        400,
      );
      return true;
    }

    if (state.config.mcp?.servers?.[serverName]) {
      delete state.config.mcp.servers[serverName];
      try {
        ctx.saveElizaConfig(state.config);
      } catch (err) {
        logger.warn(
          `[api] Config save failed: ${err instanceof Error ? err.message : err}`,
        );
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
      if (
        !body.servers ||
        typeof body.servers !== "object" ||
        Array.isArray(body.servers)
      ) {
        error(res, "servers must be a JSON object", 400);
        return true;
      }
      const mcpRejection = await ctx.resolveMcpServersRejection(
        body.servers as Record<string, unknown>,
      );
      if (mcpRejection) {
        error(res, mcpRejection, 400);
        return true;
      }
      const mcpTerminalRejection = ctx.resolveMcpTerminalAuthorizationRejection(
        req,
        body.servers as Record<string, unknown>,
        body,
      );
      if (mcpTerminalRejection) {
        error(
          res,
          `Configuring stdio MCP servers requires terminal authorization. ${mcpTerminalRejection.reason}`,
          mcpTerminalRejection.status,
        );
        return true;
      }
      const sanitized = ctx.cloneWithoutBlockedObjectKeys(body.servers);
      state.config.mcp.servers = sanitized as NonNullable<
        NonNullable<typeof state.config.mcp>["servers"]
      >;
    }

    try {
      ctx.saveElizaConfig(state.config);
    } catch (err) {
      logger.warn(
        `[api] Config save failed: ${err instanceof Error ? err.message : err}`,
      );
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
      try {
        const mcpService = state.runtime.getService("MCP") as {
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
              resourceCount: Array.isArray(s.resources)
                ? s.resources.length
                : 0,
            });
          }
        }
      } catch (err) {
        logger.debug(
          `[api] Service not available: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    json(res, { ok: true, servers });
    return true;
  }

  return false;
}
