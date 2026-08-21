/**
 * Regression coverage for the public MCP catalog's community registry degrade path.
 *
 * The platform registry should remain available when the live community lookup
 * fails, but clients must be able to distinguish "community unavailable" from
 * a genuinely empty community registry.
 */

import { expect, mock, test } from "bun:test";

const getCurrentUser = mock(async () => null);
mock.module("@/lib/auth/workers-hono-auth", () => ({ getCurrentUser }));

const listPublic = mock();
const toRegistryFormat = mock();
mock.module("@/lib/services/user-mcps", () => ({
  userMcpsService: {
    listPublic,
    toRegistryFormat,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(),
    error: mock(),
    info: mock(),
    warn: mock(),
  },
}));

const registryRoute = (await import("../mcp/registry/route")).default;

async function getRegistry(path = "/", env: Record<string, string> = {}) {
  return await registryRoute.request(path, undefined, {
    NEXT_PUBLIC_APP_URL: "https://app.example.test",
    ...env,
  });
}

test("reports DoorDash live when either managed browser or Cloud upstream is configured", async () => {
  listPublic.mockResolvedValue([]);

  const unavailableResponse = await getRegistry("/?search=DoorDash");
  const unavailable = (await unavailableResponse.json()) as {
    registry: Array<{ id: string; status: string }>;
  };
  expect(unavailable.registry).toEqual([]);

  const availableResponse = await getRegistry("/?search=DoorDash", {
    MCP_DOORDASH_STREAMABLE_HTTP_URL: "https://doordash-mcp.example.test/mcp",
  });
  const available = (await availableResponse.json()) as {
    registry: Array<{ id: string; status: string }>;
  };
  expect(available.registry).toEqual([
    expect.objectContaining({ id: "doordash", status: "live" }),
  ]);

  const managedResponse = await getRegistry("/?search=DoorDash", {
    FIRECRAWL_API_KEY: "firecrawl-test-key",
  });
  const managed = (await managedResponse.json()) as {
    registry: Array<{ id: string; status: string }>;
  };
  expect(managed.registry).toEqual([
    expect.objectContaining({ id: "doordash", status: "live" }),
  ]);
});

test("advertises every managed DoorDash tool", async () => {
  listPublic.mockResolvedValue([]);

  const response = await getRegistry("/?search=DoorDash", {
    FIRECRAWL_API_KEY: "firecrawl-test-key",
  });
  const body = (await response.json()) as {
    registry: Array<{ id: string; toolCount: number; features: string[] }>;
  };
  const doordash = body.registry.find((entry) => entry.id === "doordash");

  expect(doordash).toEqual(
    expect.objectContaining({
      id: "doordash",
      toolCount: 11,
      features: [
        "doordash_auth_check",
        "doordash_auth_clear",
        "doordash_set_address",
        "doordash_search",
        "doordash_menu",
        "doordash_add_to_cart",
        "remove_from_cart",
        "doordash_cart",
        "order_history",
        "doordash_checkout",
        "doordash_track_order",
      ],
    }),
  );
});

test("marks community registry unavailable when the optional live lookup fails", async () => {
  listPublic.mockRejectedValueOnce(new Error("community registry unavailable"));

  const response = await getRegistry();
  expect(response.status).toBe(200);

  const body = (await response.json()) as {
    registry: Array<{ source: string }>;
    platformMcps: number;
    communityMcps: number;
    communityRegistryAvailable: boolean;
  };

  expect(body.platformMcps).toBeGreaterThan(0);
  expect(body.registry.some((entry) => entry.source === "platform")).toBe(true);
  expect(body.communityMcps).toBe(0);
  expect(body.communityRegistryAvailable).toBe(false);
});

test("keeps empty community registry distinct from a failed community lookup", async () => {
  listPublic.mockResolvedValueOnce([]);

  const response = await getRegistry();
  expect(response.status).toBe(200);

  const body = (await response.json()) as {
    communityMcps: number;
    communityRegistryAvailable: boolean;
  };

  expect(body.communityMcps).toBe(0);
  expect(body.communityRegistryAvailable).toBe(true);
});

test("rejects non-canonical or out-of-range limit values before catalog lookup", async () => {
  for (const limit of [
    "5junk",
    "1e4",
    "5.5",
    "-1",
    "0",
    "101",
    "9007199254740992",
  ]) {
    listPublic.mockClear();

    const response = await getRegistry(`/?limit=${limit}`);

    expect(response.status).toBe(400);
    expect(listPublic).not.toHaveBeenCalled();
  }
});

test("accepts a canonical registry limit and reports the applied value", async () => {
  listPublic.mockResolvedValueOnce([]);

  const response = await getRegistry("/?limit=25");

  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    appliedFilters: { limit: number };
  };
  expect(body.appliedFilters.limit).toBe(25);
});
