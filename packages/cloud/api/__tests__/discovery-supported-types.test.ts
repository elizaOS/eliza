/**
 * The public discovery route advertises and executes only its real agent and
 * MCP catalog sources. The Hono handler is real; catalog and cache boundaries
 * are deterministic stubs so unsupported type tokens fail before any lookup.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const listPublicAgents = mock(async () => []);
const listPublicMcps = mock(
  async (): Promise<Array<Record<string, unknown>>> => [],
);
const countPublicMcps = mock(async () => 0);
const cacheGet = mock(async () => null);
const cacheSet = mock(async () => undefined);

// The exact pagination path also asks each selected catalog for its total
// (#19083), so a stub missing the count method would fail the handler rather
// than exercise the type contract under test.
mock.module("@/lib/services/characters/characters", () => ({
  charactersService: {
    listPublic: listPublicAgents,
    countPublicCatalog: mock(async () => 0),
  },
}));

mock.module("@/lib/services/user-mcps", () => ({
  userMcpsService: {
    listPublic: listPublicMcps,
    countPublic: countPublicMcps,
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

const discoveryModule = await import("../v1/discovery/route");
const discoveryRoute = discoveryModule.default;
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
  listPublicMcps.mockResolvedValue([]);
  countPublicMcps.mockClear();
  countPublicMcps.mockResolvedValue(0);
  cacheGet.mockClear();
  cacheSet.mockClear();
});

describe("GET /api/v1/discovery supported type contract", () => {
  test("uses the same UTF-8 byte order as PostgreSQL C collation", () => {
    const privateUse = "\uE000 private-use";
    const astral = "😀 astral";

    expect(
      [astral, privateUse].sort(discoveryModule.compareUtf8ByteOrder),
    ).toEqual([privateUse, astral]);
  });

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

  test("adds canonical USD while preserving the legacy discovery amount", async () => {
    listPublicMcps.mockResolvedValueOnce([
      {
        id: "mcp-1",
        name: "Legacy-priced MCP",
        description: "compatibility fixture",
        category: "utilities",
        tags: [],
        status: "live",
        tools: [],
        x402_enabled: false,
        is_verified: true,
        slug: "legacy-priced",
        pricing_type: "credits",
        credits_per_request: "125",
        x402_price_usd: "0",
      },
    ]);
    countPublicMcps.mockResolvedValueOnce(1);

    const response = await discover("?types=mcp");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      services: Array<{ pricing?: Record<string, unknown> }>;
    };
    expect(body.services[0]?.pricing).toEqual({
      type: "credits",
      amount: 125,
      amountUsd: 1.25,
      amountUnit: "legacy_mcp_pricing_points",
      currency: "USD",
      description: "$1.25 in cloud credit per request",
    });
  });
});
