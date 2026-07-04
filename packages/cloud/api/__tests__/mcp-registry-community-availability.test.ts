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

async function getRegistry() {
  return await registryRoute.request("/", undefined, {
    NEXT_PUBLIC_APP_URL: "https://app.example.test",
  });
}

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
