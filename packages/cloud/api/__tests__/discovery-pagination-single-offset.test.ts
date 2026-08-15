/**
 * GET /api/v1/discovery must apply the pagination offset exactly once
 * (#19076). The handler previously pushed limit/offset into each source's
 * SQL and then sliced [offset, offset+limit) again over the merged set, so
 * every page with offset >= limit came back empty and total/hasMore
 * described one already-truncated page. Real route module + real
 * repositories against in-process PGlite seeded with a public character
 * catalog and an interleaving public MCP catalog; no service mocks. The
 * two-source block covers the merge invariant the fix depends on: paging a
 * fixed limit across two independently name-windowed sources must yield the
 * globally name-ordered sequence with no duplicates and no gaps.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "bbbbbbbb-2222-4222-8222-222222222222";
const TOTAL_SEEDED = 250;
/** Every 5th character index also gets an MCP whose name sorts right after it. */
const MCP_SEED_STRIDE = 5;
const TOTAL_MCPS_SEEDED = TOTAL_SEEDED / MCP_SEED_STRIDE;
const TOTAL_BOTH_SOURCES = TOTAL_SEEDED + TOTAL_MCPS_SEEDED;

const characterName = (index: number) =>
  `Agent ${String(index).padStart(3, "0")}`;
const mcpName = (index: number) => `${characterName(index)} MCP`;

/**
 * The globally name-ordered sequence the merged agent+mcp stream must produce.
 * `"Agent 000" < "Agent 000 MCP" < "Agent 001"` under both COLLATE "C" and
 * code-unit comparison (space 0x20 sorts below every digit), so the two
 * catalogs interleave and a merge that simply concatenated one source after
 * the other could not pass.
 */
const EXPECTED_MERGED_NAMES = Array.from({ length: TOTAL_SEEDED }, (_, i) =>
  i % MCP_SEED_STRIDE === 0
    ? [characterName(i), mcpName(i)]
    : [characterName(i)],
).flat();

const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];

let pgliteReady = true;
let closeDb: (() => Promise<void>) | undefined;
let app: Hono<AppEnv>;

beforeAll(async () => {
  try {
    const { closeDatabaseConnectionsForTests, dbWrite } = await import(
      "@/db/client"
    );
    closeDb = closeDatabaseConnectionsForTests;

    const { organizations } = await import("@/db/schemas/organizations");
    const { users } = await import("@/db/schemas/users");
    const { userCharacters } = await import("@/db/schemas/user-characters");
    const { apiKeys } = await import("@/db/schemas/api-keys");
    const { containers } = await import("@/db/schemas/containers");
    const { mcpPricingTypeEnum, mcpStatusEnum, userMcps } = await import(
      "@/db/schemas/user-mcps"
    );
    const { pushSchema } = await import("@/db/push-schema-for-tests");

    // user_mcps carries pgEnum columns and a container FK; pushSchema only
    // emits the enum types and referenced tables it is handed explicitly.
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        userCharacters,
        apiKeys,
        containers,
        userMcps,
        mcpPricingTypeEnum,
        mcpStatusEnum,
      } as never,
      dbWrite as never,
    );
    await apply();

    await dbWrite
      .insert(organizations)
      .values([{ id: ORG, name: "Org", slug: "discovery-org" }]);
    await dbWrite.insert(users).values([
      {
        id: USER,
        email: "discovery-owner@test.test",
        organization_id: ORG,
        role: "owner",
        steward_user_id: `steward-${USER}`,
      },
    ]);

    // Zero-padded names sort identically under COLLATE "C" and code-unit
    // comparison, so page boundaries are exactly predictable. 250 rows put
    // the catalog beyond the 200-row repository window clamp, which is the
    // boundary the review on the first revision required crossing.
    // Insert in chunks: a single 120-row multi-values statement exceeds what
    // the PGlite driver handles comfortably in one round trip.
    const rows = Array.from({ length: TOTAL_SEEDED }, (_, i) => ({
      user_id: USER,
      organization_id: ORG,
      name: characterName(i),
      username: `discovery-agent-${String(i).padStart(3, "0")}`,
      bio: [`Discovery pagination seed number ${i}`],
      character_data: {},
      is_public: true,
      source: "cloud",
      // Every 10th row is taggable so the bounded (memory-only filter) path
      // has a deterministic 25-row subset to paginate.
      tags: i % 10 === 0 ? ["boundary-subset"] : [],
    }));
    for (let i = 0; i < rows.length; i += 20) {
      await dbWrite.insert(userCharacters).values(rows.slice(i, i + 20));
    }

    // The MCP catalog is seeded so its names fall strictly between consecutive
    // character names, which is what makes the cross-source merge observable.
    const mcpRows = Array.from({ length: TOTAL_MCPS_SEEDED }, (_, n) => {
      const i = n * MCP_SEED_STRIDE;
      return {
        organization_id: ORG,
        created_by_user_id: USER,
        name: mcpName(i),
        slug: `discovery-mcp-${String(i).padStart(3, "0")}`,
        description: `Discovery pagination mcp seed number ${i}`,
        endpoint_type: "external" as const,
        external_endpoint: `https://mcp.example.test/${i}`,
        status: "live" as const,
        is_public: true,
      };
    });
    for (let i = 0; i < mcpRows.length; i += 20) {
      await dbWrite.insert(userMcps).values(mcpRows.slice(i, i + 20));
    }

    const route = (await import("../v1/discovery/route")).default;
    app = new Hono<AppEnv>();
    app.route("/api/v1/discovery", route);
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[discovery-pagination-single-offset.test] setup failed — failing.",
      error,
    );
  }
}, 120_000);

afterAll(async () => {
  if (closeDb) await closeDb();
  mock.restore();
});

interface DiscoveryBody {
  services: Array<{ id: string; name: string; type: string }>;
  total: number;
  hasMore: boolean;
}

async function getPage(offset: number, limit = 50): Promise<DiscoveryBody> {
  const res = await app.request(
    `/api/v1/discovery?types=agent&limit=${limit}&offset=${offset}`,
    {},
    ENV,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as DiscoveryBody;
}

describe("GET /api/v1/discovery pagination (#19076/#19083)", () => {
  test("page 0 reports the exact catalog count from the dedicated COUNT", async () => {
    expect(pgliteReady).toBe(true);

    const page = await getPage(0);
    expect(page.services).toHaveLength(50);
    expect(page.total).toBe(TOTAL_SEEDED);
    expect(page.hasMore).toBe(true);
  });

  test("offset = limit returns the second page instead of an empty list", async () => {
    const page = await getPage(50);
    expect(page.services).toHaveLength(50);
    expect(page.services[0]?.name).toBe("Agent 050");
    expect(page.total).toBe(TOTAL_SEEDED);
    expect(page.hasMore).toBe(true);
  });

  test("offsets at and beyond the 200-row repository clamp stay correct", async () => {
    const atBoundary = await getPage(200);
    expect(atBoundary.services).toHaveLength(50);
    expect(atBoundary.services[0]?.name).toBe("Agent 200");
    expect(atBoundary.services[49]?.name).toBe("Agent 249");
    expect(atBoundary.total).toBe(TOTAL_SEEDED);
    expect(atBoundary.hasMore).toBe(false);

    const pastBoundary = await getPage(240);
    expect(pastBoundary.services).toHaveLength(10);
    expect(pastBoundary.services[0]?.name).toBe("Agent 240");
    expect(pastBoundary.total).toBe(TOTAL_SEEDED);
    expect(pastBoundary.hasMore).toBe(false);
  });

  test("pages are disjoint and cover every seeded row exactly once", async () => {
    const ids = new Set<string>();
    for (const offset of [0, 50, 100, 150, 200]) {
      const page = await getPage(offset);
      for (const service of page.services) {
        expect(ids.has(service.id)).toBe(false);
        ids.add(service.id);
      }
    }
    expect(ids.size).toBe(TOTAL_SEEDED);
  });

  test("a first-page request still reports the exact deep total", async () => {
    const page = await getPage(0, 1);
    expect(page.services).toHaveLength(1);
    expect(page.services[0]?.name).toBe("Agent 000");
    expect(page.total).toBe(TOTAL_SEEDED);
    expect(page.hasMore).toBe(true);
  });

  test("memory-only filters take the bounded path with an exact exhausted total", async () => {
    const res = await app.request(
      "/api/v1/discovery?types=agent&tags=boundary-subset&limit=10&offset=10",
      {},
      ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as DiscoveryBody;
    // 25 tagged rows total (every 10th of 250); page 2 of 10 is Agent 100..190.
    expect(body.services).toHaveLength(10);
    expect(body.services[0]?.name).toBe("Agent 100");
    expect(body.total).toBe(25);
    expect(body.hasMore).toBe(true);

    const tail = await app.request(
      "/api/v1/discovery?types=agent&tags=boundary-subset&limit=10&offset=20",
      {},
      ENV,
    );
    const tailBody = (await tail.json()) as DiscoveryBody;
    expect(tailBody.services).toHaveLength(5);
    expect(tailBody.hasMore).toBe(false);
  });

  test("rejects invalid or over-ceiling page windows with a 400", async () => {
    const res = await app.request(
      "/api/v1/discovery?types=agent&limit=50&offset=100000",
      {},
      ENV,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Invalid parameters");

    const atCeiling = await app.request(
      "/api/v1/discovery?types=agent&limit=50&offset=1000",
      {},
      ENV,
    );
    expect(atCeiling.status).toBe(400);

    const beyondDepth = await app.request(
      "/api/v1/discovery?types=agent&limit=200&offset=900",
      {},
      ENV,
    );
    expect(beyondDepth.status).toBe(400);

    const decimalOffset = await app.request(
      "/api/v1/discovery?types=agent&limit=50&offset=0.5",
      {},
      ENV,
    );
    expect(decimalOffset.status).toBe(400);

    const atDepth = await app.request(
      "/api/v1/discovery?types=agent&limit=50&offset=950",
      {},
      ENV,
    );
    expect(atDepth.status).toBe(200);
  });
});

describe("GET /api/v1/discovery two-source merge (#19083)", () => {
  async function getMergedPage(
    offset: number,
    limit: number,
  ): Promise<DiscoveryBody> {
    const res = await app.request(
      `/api/v1/discovery?limit=${limit}&offset=${offset}`,
      {},
      ENV,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as DiscoveryBody;
  }

  test("the default request counts both catalogs", async () => {
    expect(pgliteReady).toBe(true);

    const page = await getMergedPage(0, 40);
    expect(page.total).toBe(TOTAL_BOTH_SOURCES);
    expect(page.hasMore).toBe(true);
    expect(page.services.map((s) => s.name)).toEqual(
      EXPECTED_MERGED_NAMES.slice(0, 40),
    );
    expect(page.services.some((s) => s.type === "mcp")).toBe(true);
    expect(page.services.some((s) => s.type === "agent")).toBe(true);
  });

  test("paging a fixed limit reproduces the global name order with no gaps or duplicates", async () => {
    const limit = 40;
    const names: string[] = [];
    const ids = new Set<string>();

    for (let offset = 0; offset < TOTAL_BOTH_SOURCES; offset += limit) {
      const page = await getMergedPage(offset, limit);
      expect(page.total).toBe(TOTAL_BOTH_SOURCES);
      expect(page.services).toHaveLength(
        Math.min(limit, TOTAL_BOTH_SOURCES - offset),
      );
      expect(page.hasMore).toBe(
        offset + page.services.length < TOTAL_BOTH_SOURCES,
      );
      for (const service of page.services) {
        expect(ids.has(service.id)).toBe(false);
        ids.add(service.id);
        names.push(service.name);
      }
    }

    expect(names).toEqual(EXPECTED_MERGED_NAMES);
    expect(ids.size).toBe(TOTAL_BOTH_SOURCES);
  });

  test("a deep merged page past both single-source window clamps stays aligned", async () => {
    // Offset 280 sits past the 200-row repository clamp on the agent side and
    // past the entire MCP catalog, so the page can only be right if the offset
    // is applied once, to the merged stream.
    const page = await getMergedPage(280, 10);
    expect(page.services.map((s) => s.name)).toEqual(
      EXPECTED_MERGED_NAMES.slice(280, 290),
    );
    expect(page.total).toBe(TOTAL_BOTH_SOURCES);
    expect(page.hasMore).toBe(true);
  });

  test("the final merged page reports completion", async () => {
    const page = await getMergedPage(TOTAL_BOTH_SOURCES - 5, 50);
    expect(page.services.map((s) => s.name)).toEqual(
      EXPECTED_MERGED_NAMES.slice(TOTAL_BOTH_SOURCES - 5),
    );
    expect(page.hasMore).toBe(false);
  });
});

describe("dedupe identity and multi-category correctness (#19083 review)", () => {
  const ORG2 = "33333333-3333-4333-8333-333333333333";
  const USER2 = "cccccccc-3333-4333-8333-333333333333";

  beforeAll(async () => {
    // Seeded AFTER the earlier describes have run, so their exact totals are
    // untouched. Names start with "ZZ" so these rows sort after every
    // existing seed under both COLLATE "C" and code-unit order.
    const { dbWrite } = await import("@/db/client");
    const { organizations } = await import("@/db/schemas/organizations");
    const { users } = await import("@/db/schemas/users");
    const { userCharacters } = await import("@/db/schemas/user-characters");
    const { userMcps } = await import("@/db/schemas/user-mcps");

    await dbWrite
      .insert(organizations)
      .values([{ id: ORG2, name: "Org Two", slug: "discovery-org-two" }]);
    await dbWrite.insert(users).values([
      {
        id: USER2,
        email: "discovery-owner-two@test.test",
        organization_id: ORG2,
        role: "owner",
        steward_user_id: `steward-${USER2}`,
      },
    ]);

    // The reviewer's case: two organizations exposing the SAME
    // slug+name+description MCP — one visible discovery identity, two rows.
    await dbWrite.insert(userMcps).values(
      [ORG, ORG2].map((org) => ({
        organization_id: org,
        created_by_user_id: org === ORG ? USER : USER2,
        name: "ZZdup Shared Connector",
        slug: "zzdup-shared-connector",
        description: "Cross-organization duplicate seed",
        endpoint_type: "external" as const,
        external_endpoint: `https://mcp.example.test/dup-${org.slice(0, 4)}`,
        status: "live" as const,
        is_public: true,
      })),
    );
    await dbWrite.insert(userMcps).values([
      {
        organization_id: ORG,
        created_by_user_id: USER,
        name: "ZZunique Solo Connector",
        slug: "zzunique-solo-connector",
        description: "Unique row that must not fall off the page",
        endpoint_type: "external" as const,
        external_endpoint: "https://mcp.example.test/zzunique",
        status: "live" as const,
        is_public: true,
      },
    ]);

    // Multi-category seeds: 3 rows in zz-cat-a, 2 in zz-cat-b.
    await dbWrite.insert(userCharacters).values(
      Array.from({ length: 5 }, (_, i) => ({
        user_id: USER,
        organization_id: ORG,
        name: `ZZcat ${i < 3 ? "A" : "B"} ${i}`,
        username: `discovery-zzcat-${i}`,
        bio: [`Multi-category seed ${i}`],
        character_data: {},
        is_public: true,
        source: "cloud",
        category: i < 3 ? "zz-cat-a" : "zz-cat-b",
      })),
    );
  }, 60_000);

  async function getRaw(query: string): Promise<DiscoveryBody> {
    const res = await app.request(`/api/v1/discovery?${query}`, {}, ENV);
    expect(res.status).toBe(200);
    return (await res.json()) as DiscoveryBody;
  }

  test("cross-org duplicate collapses to one identity in page AND total", async () => {
    // The dup pair sorts as the last-but-one identity; ask for the tail of
    // the mcp catalog. activeOnly is spelled out to match the other cases;
    // it does not change the cache key, which is hashed from the parsed
    // params where activeOnly already defaults to true.
    const tail = await getRaw(
      `types=mcp&limit=50&offset=${TOTAL_MCPS_SEEDED}&activeOnly=true`,
    );
    const names = tail.services.map((s) => s.name);
    expect(names).toEqual([
      "ZZdup Shared Connector",
      "ZZunique Solo Connector",
    ]);
    // total counts identities, not raw rows: seeded mcps + dup(1) + unique(1).
    expect(tail.total).toBe(TOTAL_MCPS_SEEDED + 2);
    expect(tail.hasMore).toBe(false);
  });

  test("a duplicate consuming the prefix cannot push a unique row off its page", async () => {
    // limit=1 pages walked one by one across the tail: the duplicate pair
    // occupies exactly one page slot and the unique row still gets its own.
    const dupPage = await getRaw(
      `types=mcp&limit=1&offset=${TOTAL_MCPS_SEEDED}&activeOnly=true`,
    );
    expect(dupPage.services.map((s) => s.name)).toEqual([
      "ZZdup Shared Connector",
    ]);
    expect(dupPage.hasMore).toBe(true);

    const uniquePage = await getRaw(
      `types=mcp&limit=1&offset=${TOTAL_MCPS_SEEDED + 1}&activeOnly=true`,
    );
    expect(uniquePage.services.map((s) => s.name)).toEqual([
      "ZZunique Solo Connector",
    ]);
    expect(uniquePage.hasMore).toBe(false);
  });

  test("multi-category requests fetch and paginate every requested category", async () => {
    const all = await getRaw(
      "types=agent&categories=zz-cat-a,zz-cat-b&limit=3&offset=0&activeOnly=true",
    );
    expect(all.services.map((s) => s.name)).toEqual([
      "ZZcat A 0",
      "ZZcat A 1",
      "ZZcat A 2",
    ]);
    expect(all.total).toBe(5);
    expect(all.hasMore).toBe(true);

    const second = await getRaw(
      "types=agent&categories=zz-cat-a,zz-cat-b&limit=3&offset=3&activeOnly=true",
    );
    expect(second.services.map((s) => s.name)).toEqual([
      "ZZcat B 3",
      "ZZcat B 4",
    ]);
    expect(second.hasMore).toBe(false);
  });
});
