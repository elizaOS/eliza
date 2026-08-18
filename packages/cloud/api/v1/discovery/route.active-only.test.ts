/** Exercises discovery active-filter validation before catalog queries. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const listPublicAgents = mock(async () => []);
const listPublicMcps = mock(async () => []);
const cacheGet = mock(async () => null);
const cacheSet = mock(async () => undefined);

mock.module("@/lib/services/characters/characters", () => ({
  charactersService: {
    listPublic: listPublicAgents,
    countPublicCatalog: mock(async () => 0),
  },
}));
mock.module("@/lib/services/user-mcps", () => ({
  userMcpsService: {
    listPublic: listPublicMcps,
    countPublic: mock(async () => 0),
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

const discoveryModule = await import("./route");
const app = new Hono<AppEnv>();
app.route("/api/v1/discovery", discoveryModule.default);

const ENV = {
  NODE_ENV: "test",
  NEXT_PUBLIC_APP_URL: "https://app.example.test",
} as unknown as AppEnv["Bindings"];

function discover(query = "") {
  return app.request(`/api/v1/discovery${query}`, {}, ENV);
}

describe("GET /api/v1/discovery activeOnly identity", () => {
  beforeEach(() => {
    listPublicAgents.mockClear();
    listPublicMcps.mockClear();
    cacheGet.mockClear();
    cacheSet.mockClear();
  });

  test.each(["", "?activeOnly=", "?activeOnly=true"])(
    "accepts %s as the live discovery catalog",
    async (query) => {
      const response = await discover(query);
      expect(response.status).toBe(200);
      expect(listPublicAgents).toHaveBeenCalledTimes(1);
      expect(listPublicMcps).toHaveBeenCalledTimes(1);
    },
  );

  test("accepts activeOnly=false as the full discovery catalog", async () => {
    const response = await discover("?activeOnly=false");
    expect(response.status).toBe(200);
    expect(listPublicAgents).toHaveBeenCalledTimes(1);
    expect(listPublicMcps).toHaveBeenCalledTimes(1);
  });

  test.each(["FALSE", "TRUE", "0", "1", "no", "yes", "foo", "1e2"])(
    "rejects activeOnly=%s before catalog lookup",
    async (token) => {
      const response = await discover(
        `?activeOnly=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid activeOnly");
      expect(listPublicAgents).not.toHaveBeenCalled();
      expect(listPublicMcps).not.toHaveBeenCalled();
      expect(cacheGet).not.toHaveBeenCalled();
    },
  );

  test.each([
    "?activeOnly=true&activeOnly=true",
    "?activeOnly=true&activeOnly=false",
    "?activeOnly=&activeOnly=true",
    "?activeOnly=foo&activeOnly=true",
  ])(
    "rejects duplicate activeOnly values in %s before catalog lookup",
    async (query) => {
      const response = await discover(query);
      expect(response.status).toBe(400);
      expect(listPublicAgents).not.toHaveBeenCalled();
      expect(listPublicMcps).not.toHaveBeenCalled();
      expect(cacheGet).not.toHaveBeenCalled();
    },
  );
});
