import type http from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchMcpMarketplace } from "../src/mcp-marketplace.js";
import { handleMcpRoutes, type McpRouteContext } from "../src/routes-mcp";

vi.mock("../src/mcp-marketplace.js", () => ({
  getMcpServerDetails: vi.fn(),
  searchMcpMarketplace: vi.fn(),
}));

type RouteBody = Record<string, unknown> | null;

function isBlockedObjectKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function cloneWithoutBlockedObjectKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneWithoutBlockedObjectKeys(item)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (isBlockedObjectKey(key)) continue;
      out[key] = cloneWithoutBlockedObjectKeys(child);
    }
    return out as T;
  }
  return value;
}

function makeCtx(
  method: string,
  pathname: string,
  options: {
    body?: RouteBody;
    query?: string;
    config?: McpRouteContext["state"]["config"];
    runtime?: McpRouteContext["state"]["runtime"];
    resolveMcpServersRejection?: McpRouteContext["resolveMcpServersRejection"];
    resolveMcpTerminalAuthorizationRejection?: McpRouteContext["resolveMcpTerminalAuthorizationRejection"];
    decodePathComponent?: McpRouteContext["decodePathComponent"];
    saveElizaConfig?: McpRouteContext["saveElizaConfig"];
  } = {}
): McpRouteContext & {
  response: { status: number; body: unknown };
  saveElizaConfig: ReturnType<typeof vi.fn>;
} {
  const response = { status: 0, body: undefined as unknown };
  const saveElizaConfig = vi.fn(options.saveElizaConfig ?? (() => {}));
  const req = { headers: {} } as http.IncomingMessage;
  const res = {} as http.ServerResponse;

  return {
    req,
    res,
    method,
    pathname,
    url: new URL(`http://localhost${pathname}${options.query ?? ""}`),
    state: {
      config: options.config ?? {},
      runtime: options.runtime ?? null,
    },
    json: (_res, data, status = 200) => {
      response.status = status;
      response.body = data;
    },
    error: (_res, message, status = 500) => {
      response.status = status;
      response.body = { ok: false, error: message };
    },
    readJsonBody: vi.fn(async () => options.body),
    saveElizaConfig,
    redactDeep: (value) => value,
    isBlockedObjectKey,
    cloneWithoutBlockedObjectKeys,
    resolveMcpServersRejection: options.resolveMcpServersRejection ?? vi.fn(async () => null),
    resolveMcpTerminalAuthorizationRejection:
      options.resolveMcpTerminalAuthorizationRejection ?? vi.fn(() => null),
    decodePathComponent:
      options.decodePathComponent ??
      ((raw, _res, _label) => {
        try {
          return decodeURIComponent(raw);
        } catch {
          response.status = 400;
          response.body = { ok: false, error: "Invalid path component" };
          return null;
        }
      }),
    response,
  };
}

describe("handleMcpRoutes", () => {
  beforeEach(() => {
    vi.mocked(searchMcpMarketplace).mockReset();
    vi.mocked(searchMcpMarketplace).mockResolvedValue({ results: [] });
  });

  it.each([
    ["10junk", 30],
    ["999", 50],
    ["0", 1],
    ["12", 12],
  ])("sanitizes marketplace search limit %s to %s", async (rawLimit, expectedLimit) => {
    const ctx = makeCtx("GET", "/api/mcp/marketplace/search", {
      query: `?q=files&limit=${encodeURIComponent(rawLimit)}`,
    });

    await expect(handleMcpRoutes(ctx)).resolves.toBe(true);

    expect(searchMcpMarketplace).toHaveBeenCalledWith("files", expectedLimit);
    expect(ctx.response).toEqual({ status: 200, body: { ok: true, results: [] } });
  });

  it("rejects malformed config bodies before saving server config", async () => {
    const ctx = makeCtx("POST", "/api/mcp/config/server", {
      body: { name: "files", config: [] },
    });

    await expect(handleMcpRoutes(ctx)).resolves.toBe(true);

    expect(ctx.response.status).toBe(400);
    expect(ctx.response.body).toEqual({
      ok: false,
      error: "Server config object is required",
    });
    expect(ctx.saveElizaConfig).not.toHaveBeenCalled();
  });

  it("rejects reserved server names on config replacement", async () => {
    const ctx = makeCtx("PUT", "/api/mcp/config", {
      body: { servers: JSON.parse('{"__proto__":{"type":"http","url":"https://example.com"}}') },
    });

    await expect(handleMcpRoutes(ctx)).resolves.toBe(true);

    expect(ctx.response.status).toBe(400);
    expect(ctx.response.body).toEqual({
      ok: false,
      error: 'Invalid server name: "__proto__", "constructor", and "prototype" are reserved',
    });
    expect(ctx.state.config.mcp?.servers).toBeUndefined();
    expect(ctx.saveElizaConfig).not.toHaveBeenCalled();
  });

  it("does not persist stdio server config when terminal authorization is denied", async () => {
    const ctx = makeCtx("POST", "/api/mcp/config/server", {
      body: { name: "local", config: { type: "stdio", command: "node" } },
      resolveMcpTerminalAuthorizationRejection: vi.fn(() => ({
        reason: "missing terminal token",
        status: 403,
      })),
    });

    await expect(handleMcpRoutes(ctx)).resolves.toBe(true);

    expect(ctx.response).toEqual({
      status: 403,
      body: {
        ok: false,
        error:
          "Configuring stdio MCP servers requires terminal authorization. missing terminal token",
      },
    });
    expect(ctx.state.config.mcp?.servers).toBeUndefined();
    expect(ctx.saveElizaConfig).not.toHaveBeenCalled();
  });

  it("persists sanitized config and still returns success when config save fails", async () => {
    const ctx = makeCtx("POST", "/api/mcp/config/server", {
      body: {
        name: "remote",
        config: JSON.parse(
          '{"type":"http","url":"https://example.com","headers":{"authorization":"token","constructor":{"polluted":true}}}'
        ),
      },
      saveElizaConfig: () => {
        throw new Error("disk full");
      },
    });

    await expect(handleMcpRoutes(ctx)).resolves.toBe(true);

    expect(ctx.response).toEqual({
      status: 200,
      body: { ok: true, name: "remote", requiresRestart: true },
    });
    expect(ctx.state.config.mcp?.servers?.remote).toEqual({
      type: "http",
      url: "https://example.com",
      headers: { authorization: "token" },
    });
  });

  it("treats malformed path params as handled without deleting config", async () => {
    const config = { mcp: { servers: { remote: { type: "http", url: "https://example.com" } } } };
    const ctx = makeCtx("DELETE", "/api/mcp/config/server/%E0%A4%A", {
      config,
    });

    await expect(handleMcpRoutes(ctx)).resolves.toBe(true);

    expect(ctx.response.status).toBe(400);
    expect(config.mcp.servers.remote).toBeDefined();
    expect(ctx.saveElizaConfig).not.toHaveBeenCalled();
  });

  it("returns empty status when the MCP service lookup fails", async () => {
    const ctx = makeCtx("GET", "/api/mcp/status", {
      runtime: {
        getService: () => {
          throw new Error("service registry unavailable");
        },
      },
    });

    await expect(handleMcpRoutes(ctx)).resolves.toBe(true);

    expect(ctx.response).toEqual({ status: 200, body: { ok: true, servers: [] } });
  });
});
