/**
 * GET /api/mcp/registry — community-subset load failure must be observable.
 *
 * The registry serves an always-available built-in catalog plus a community
 * subset from userMcpsService.listPublic(). A failed community lookup must NOT
 * read as "zero community MCPs": the response degrades to built-in-only while
 * flagging communityRegistryAvailable:false, so the client can distinguish
 * "not loaded" (service failure) from a genuinely-empty community set. Drives
 * the real Hono handler with the community service stubbed to resolve/reject.
 */

import { describe, expect, mock, test } from "bun:test";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as userMcpsActual from "@/lib/services/user-mcps";
import * as loggerActual from "@/lib/utils/logger";

const listPublic = mock<(...args: unknown[]) => Promise<unknown[]>>();
const toRegistryFormat = mock((mcp: { id: string }, baseUrl: string) => ({
  id: mcp.id,
  name: `Community ${mcp.id}`,
  description: "community mcp",
  category: "data",
  status: "live",
  features: [] as string[],
  endpoint: `${baseUrl}/api/mcp/proxy/${mcp.id}`,
}));

// Object.create keeps the real instance as prototype so every other method still
// resolves — only listPublic/toRegistryFormat are shadowed, and co-running test
// files that import userMcpsService are unaffected.
const mockUserMcpsService = Object.create(userMcpsActual.userMcpsService);
mockUserMcpsService.listPublic = listPublic;
mockUserMcpsService.toRegistryFormat = toRegistryFormat;

mock.module("@/lib/services/user-mcps", () => ({
  ...userMcpsActual,
  userMcpsService: mockUserMcpsService,
}));

// Optional auth resolves to anonymous so the handler never touches the DB.
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  getCurrentUser: mock(async () => null),
}));

mock.module("@/lib/utils/logger", () => ({
  ...loggerActual,
  logger: {
    ...loggerActual.logger,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

const registryRoute = (await import("../mcp/registry/route")) as {
  default: { fetch: (req: Request, env?: unknown) => Promise<Response> };
};

const ENV = { NODE_ENV: "test", NEXT_PUBLIC_APP_URL: "https://test.local" };

function get(): Promise<Response> {
  return registryRoute.default.fetch(
    new Request("http://test.local/", { method: "GET" }),
    ENV,
  );
}

type RegistryBody = {
  registry: unknown[];
  communityMcps: number;
  platformMcps: number;
  communityRegistryAvailable: boolean;
};

describe("GET /api/mcp/registry community degrade", () => {
  test("healthy empty community set → available:true, 0 community MCPs", async () => {
    listPublic.mockResolvedValueOnce([]);
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as RegistryBody;
    expect(body.communityRegistryAvailable).toBe(true);
    expect(body.communityMcps).toBe(0);
    expect(body.platformMcps).toBeGreaterThan(0);
  });

  test("populated community set → available:true, counts the community MCPs", async () => {
    listPublic.mockResolvedValueOnce([{ id: "abc" }]);
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as RegistryBody;
    expect(body.communityRegistryAvailable).toBe(true);
    expect(body.communityMcps).toBe(1);
  });

  test("community lookup REJECTS → still 200 (catalog available) but available:false, distinguishable from empty", async () => {
    listPublic.mockRejectedValueOnce(new Error("D1_ERROR: connection reset"));
    const res = await get();
    // The built-in catalog stays served (availability preserved)...
    expect(res.status).toBe(200);
    const body = (await res.json()) as RegistryBody;
    // ...but the failure is surfaced, NOT fabricated as a healthy empty set.
    expect(body.communityRegistryAvailable).toBe(false);
    expect(body.communityMcps).toBe(0);
    expect(body.platformMcps).toBeGreaterThan(0);
  });

  test("failure flag (false) is distinguishable from a legitimately-empty set (true)", async () => {
    listPublic.mockResolvedValueOnce([]);
    const healthy = (await (await get()).json()) as RegistryBody;
    listPublic.mockRejectedValueOnce(new Error("timeout"));
    const degraded = (await (await get()).json()) as RegistryBody;
    // Same communityMcps:0, but the availability flag disambiguates them.
    expect(healthy.communityMcps).toBe(degraded.communityMcps);
    expect(healthy.communityRegistryAvailable).toBe(true);
    expect(degraded.communityRegistryAvailable).toBe(false);
  });
});
