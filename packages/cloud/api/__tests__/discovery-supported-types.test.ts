/**
 * The public discovery route advertises and executes only its real agent and
 * MCP catalog sources. The Hono handler is real; catalog and cache boundaries
 * are deterministic stubs so unsupported type tokens fail before any lookup.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const listPublicAgents = mock(async () => []);
const listPublicMcps = mock(async () => []);
const cacheGet = mock(async () => null);
const cacheSet = mock(async () => undefined);

mock.module("@/lib/services/characters/characters", () => ({
  charactersService: { listPublic: listPublicAgents },
}));

mock.module("@/lib/services/user-mcps", () => ({
  userMcpsService: {
    listPublic: listPublicMcps,
    getPublicProxyUrl: mock(() => "https://app.example.test/mcp"),
  },
}));

mock.module("@/lib/cache/client", () => ({
  cache: { get: cacheGet, set: cacheSet },
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_context: unknown, next: () => Promise<void>) =>
    next(),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(),
    error: mock(),
    info: mock(),
    warn: mock(),
  },
}));

const discoveryRoute = (await import("../v1/discovery/route")).default;
const app = new Hono<AppEnv>();
app.route("/api/v1/discovery", discoveryRoute);

const ENV = {
  NODE_ENV: "test",
  NEXT_PUBLIC_APP_URL: "https://app.example.test",
} as unknown as AppEnv["Bindings"];

async function discover(query = ""): Promise<Response> {
  return app.request(`/api/v1/discovery${query}`, {}, ENV);
}

beforeEach(() => {
  listPublicAgents.mockClear();
  listPublicMcps.mockClear();
  cacheGet.mockClear();
  cacheSet.mockClear();
});

describe("GET /api/v1/discovery supported type contract", () => {
  test("the default request fetches both supported catalogs", async () => {
    const response = await discover();

    expect(response.status).toBe(200);
    expect(listPublicAgents).toHaveBeenCalledTimes(1);
    expect(listPublicMcps).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["agent", 1, 0],
    ["mcp", 0, 1],
  ] as const)(
    "an explicit %s request fetches only that catalog",
    async (type, agentCalls, mcpCalls) => {
      const response = await discover(`?types=${type}`);

      expect(response.status).toBe(200);
      expect(listPublicAgents).toHaveBeenCalledTimes(agentCalls);
      expect(listPublicMcps).toHaveBeenCalledTimes(mcpCalls);
    },
  );

  test.each(["app", "a2a", "unknown", "", "agent,app"])(
    "rejects unsupported type list %j before catalog lookup",
    async (types) => {
      const response = await discover(`?types=${types}`);

      expect(response.status).toBe(400);
      expect(listPublicAgents).not.toHaveBeenCalled();
      expect(listPublicMcps).not.toHaveBeenCalled();
      expect(cacheGet).not.toHaveBeenCalled();

      const body = (await response.json()) as { error?: string };
      expect(body.error).toBe("Invalid parameters");
    },
  );

  test("trims supported comma-separated type tokens", async () => {
    const response = await discover("?types=agent%2C%20mcp");

    expect(response.status).toBe(200);
    expect(listPublicAgents).toHaveBeenCalledTimes(1);
    expect(listPublicMcps).toHaveBeenCalledTimes(1);
  });
});
