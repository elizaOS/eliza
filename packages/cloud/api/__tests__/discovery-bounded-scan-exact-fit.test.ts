/**
 * The discovery bounded path (memory-only filters) must not report a source
 * that holds exactly the per-source scan ceiling as truncated (#19083). Such a
 * catalog was scanned to exhaustion, so its last page is complete and
 * `hasMore` must be false; the previous loop broke on "reached depth" without
 * ever learning whether another row existed, permanently pinning
 * `hasMore: true`. The Hono route is real; the two catalog sources and the
 * cache are deterministic in-memory stubs so the window loop — not Postgres —
 * is the system under test.
 */

import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

/** Mirrors BOUNDED_SCAN_CEILING in the route under test. */
const BOUNDED_SCAN_CEILING = 1_000;

const CHARACTERS = Array.from({ length: BOUNDED_SCAN_CEILING }, (_, i) => ({
  id: `char-${String(i).padStart(4, "0")}`,
  name: `Agent ${String(i).padStart(4, "0")}`,
  bio: [`bounded scan seed ${i}`],
  avatar_url: null,
  category: "utilities",
  tags: ["exact-fit"],
  monetization_enabled: false,
  inference_markup_percentage: 0,
  slug: `agent-${String(i).padStart(4, "0")}`,
}));

const listPublicAgents = mock(
  async ({ limit = 50, offset = 0 }: { limit?: number; offset?: number }) =>
    CHARACTERS.slice(offset, offset + Math.min(limit, 200)),
);

mock.module("@/lib/services/characters/characters", () => ({
  charactersService: {
    listPublic: listPublicAgents,
    countPublicCatalog: mock(async () => CHARACTERS.length),
  },
}));

mock.module("@/lib/services/user-mcps", () => ({
  userMcpsService: {
    listPublic: mock(async () => []),
    countPublic: mock(async () => 0),
    getPublicProxyUrl: mock(() => "https://app.example.test/mcp"),
  },
}));

const cacheClientActualModule = await import("@/lib/cache/client");

mock.module("@/lib/cache/client", () => ({
  ...cacheClientActualModule,
  cache: {
    get: mock(async () => null),
    set: mock(async () => undefined),
    delConfirmed: async () => true,
    delPatternConfirmed: async () => true,
  },
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_context: unknown, next: () => Promise<void>) =>
    next(),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { debug: mock(), error: mock(), info: mock(), warn: mock() },
}));

const discoveryRoute = (await import("../v1/discovery/route")).default;
const app = new Hono<AppEnv>();
app.route("/api/v1/discovery", discoveryRoute);

const ENV = {
  NODE_ENV: "test",
  NEXT_PUBLIC_APP_URL: "https://app.example.test",
} as unknown as AppEnv["Bindings"];

interface DiscoveryBody {
  services: Array<{ id: string; name: string }>;
  total: number;
  hasMore: boolean;
}

async function bounded(offset: number, limit: number): Promise<DiscoveryBody> {
  const res = await app.request(
    `/api/v1/discovery?types=agent&tags=exact-fit&limit=${limit}&offset=${offset}`,
    {},
    ENV,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as DiscoveryBody;
}

describe("GET /api/v1/discovery bounded-path exact fit (#19083)", () => {
  test("a source holding exactly the scan ceiling completes instead of paging forever", async () => {
    const last = await bounded(BOUNDED_SCAN_CEILING - 50, 50);

    expect(last.services).toHaveLength(50);
    expect(last.services[49]?.name).toBe("Agent 0999");
    expect(last.total).toBe(BOUNDED_SCAN_CEILING);
    expect(last.hasMore).toBe(false);
  });

  test("earlier pages of the same exhausted scan still report more", async () => {
    const first = await bounded(0, 50);

    expect(first.services[0]?.name).toBe("Agent 0000");
    expect(first.total).toBe(BOUNDED_SCAN_CEILING);
    expect(first.hasMore).toBe(true);
  });
});
