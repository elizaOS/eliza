/**
 * GET /api/my-agents/characters sort, order, and pagination must match the
 * pre-#18339 route: sort only by the requested field (default newest desc),
 * never featured-first. Real route + PGlite; auth is mocked.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { Hono } from "hono";
import * as realAuth from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "bbbbbbbb-2222-4222-8222-222222222222";

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg: mock(async () => ({
    id: USER,
    email: "sort-owner@test.test",
    organization_id: ORG,
    organization: { id: ORG, name: "Sort Org", is_active: true },
    is_active: true,
    role: "owner",
  })),
}));

const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];

let pgliteReady = true;
let closeDb: (() => Promise<void>) | undefined;
let app: Hono<AppEnv>;

type ListResponse = {
  success: boolean;
  data: {
    characters: Array<{ id: string; name: string }>;
    pagination: {
      page: number;
      limit: number;
      totalPages: number;
      totalCount: number;
      hasMore: boolean;
    };
  };
};

beforeAll(async () => {
  try {
    const { closeDatabaseConnectionsForTests, dbWrite } = await import(
      "@/db/client"
    );
    closeDb = closeDatabaseConnectionsForTests;

    const { organizations } = await import("@/db/schemas/organizations");
    const { users } = await import("@/db/schemas/users");
    const { userCharacters } = await import("@/db/schemas/user-characters");
    const { elizaRoomCharactersTable } = await import(
      "@/db/schemas/eliza-room-characters"
    );
    const { agentTable } = await import("@/db/schemas/eliza");
    const { pushSchema } = await import("@/db/push-schema-for-tests");
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        userCharacters,
        elizaRoomCharactersTable,
        agentTable,
      } as never,
      dbWrite as never,
    );
    await apply();

    await dbWrite
      .insert(organizations)
      .values([{ id: ORG, name: "Sort Org", slug: "sort-org" }]);
    await dbWrite.insert(users).values([
      {
        id: USER,
        email: "sort-owner@test.test",
        organization_id: ORG,
        role: "owner",
        steward_user_id: `steward-${USER}`,
      },
    ]);

    const base = {
      organization_id: ORG,
      user_id: USER,
      bio: ["test bio"],
      character_data: {},
      source: "cloud" as const,
    };

    await dbWrite.insert(userCharacters).values([
      {
        ...base,
        id: "cccccccc-0001-4222-8222-000000000001",
        name: "Zulu Agent",
        username: "zulu-agent",
        featured: true,
        created_at: new Date("2026-01-01T00:00:00.000Z"),
        updated_at: new Date("2026-01-02T00:00:00.000Z"),
      },
      {
        ...base,
        id: "cccccccc-0002-4222-8222-000000000002",
        name: "Alpha Agent",
        username: "alpha-agent",
        featured: false,
        created_at: new Date("2026-01-03T00:00:00.000Z"),
        updated_at: new Date("2026-01-04T00:00:00.000Z"),
      },
      {
        ...base,
        id: "cccccccc-0003-4222-8222-000000000003",
        name: "Mike Agent",
        username: "mike-agent",
        featured: false,
        created_at: new Date("2026-01-02T00:00:00.000Z"),
        updated_at: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    const route = (await import("../my-agents/characters/route")).default;
    app = new Hono<AppEnv>();
    app.route("/api/my-agents/characters", route);
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[my-agents-characters-sort-pagination.test] setup failed — failing.",
      error,
    );
  }
}, 120_000);

afterAll(async () => {
  if (closeDb) await closeDb();
  mock.restore();
});

async function listCharacters(query = ""): Promise<ListResponse> {
  const res = await app.request(`/api/my-agents/characters${query}`, {}, ENV);
  expect(res.status).toBe(200);
  return (await res.json()) as ListResponse;
}

describe("GET /api/my-agents/characters — sort and pagination", () => {
  test("default newest desc does not pin featured characters first", async () => {
    expect(pgliteReady).toBe(true);

    const body = await listCharacters();
    expect(body.data.characters.map((c) => c.name)).toEqual([
      "Alpha Agent",
      "Mike Agent",
      "Zulu Agent",
    ]);
  });

  test("sortBy=name&order=asc orders alphabetically", async () => {
    expect(pgliteReady).toBe(true);

    const body = await listCharacters("?sortBy=name&order=asc");
    expect(body.data.characters.map((c) => c.name)).toEqual([
      "Alpha Agent",
      "Mike Agent",
      "Zulu Agent",
    ]);
  });

  test("sortBy=name&order=desc reverses alphabetical order", async () => {
    expect(pgliteReady).toBe(true);

    const body = await listCharacters("?sortBy=name&order=desc");
    expect(body.data.characters.map((c) => c.name)).toEqual([
      "Zulu Agent",
      "Mike Agent",
      "Alpha Agent",
    ]);
  });

  test("sortBy=updated&order=desc uses updated_at, not featured", async () => {
    expect(pgliteReady).toBe(true);

    const body = await listCharacters("?sortBy=updated&order=desc");
    expect(body.data.characters.map((c) => c.name)).toEqual([
      "Alpha Agent",
      "Zulu Agent",
      "Mike Agent",
    ]);
  });

  test("pagination returns the requested page slice and metadata", async () => {
    expect(pgliteReady).toBe(true);

    const page1 = await listCharacters("?sortBy=name&order=asc&page=1&limit=2");
    expect(page1.data.characters.map((c) => c.name)).toEqual([
      "Alpha Agent",
      "Mike Agent",
    ]);
    expect(page1.data.pagination).toMatchObject({
      page: 1,
      limit: 2,
      totalCount: 3,
      totalPages: 2,
      hasMore: true,
    });

    const page2 = await listCharacters("?sortBy=name&order=asc&page=2&limit=2");
    expect(page2.data.characters.map((c) => c.name)).toEqual(["Zulu Agent"]);
    expect(page2.data.pagination).toMatchObject({
      page: 2,
      limit: 2,
      totalCount: 3,
      totalPages: 2,
      hasMore: false,
    });
  });
});
