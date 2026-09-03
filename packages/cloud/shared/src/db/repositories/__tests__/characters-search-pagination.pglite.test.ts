/** Real-PGlite proof that character search pagination is a total order walk. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const { closeDatabaseConnectionsForTests, dbWrite } = await import("../../client");
const { organizations } = await import("../../schemas/organizations");
const { users } = await import("../../schemas/users");
const { userCharacters } = await import("../../schemas/user-characters");
const { elizaRoomCharactersTable } = await import("../../schemas/eliza-room-characters");
const { UserCharactersRepository } = await import("../characters");
const { pushSchema } = await import("drizzle-kit/api");

const TIMEOUT = 120_000;
const PAGE_SIZE = 30;
const ROW_COUNT = 300;
const ORG_ID = "00000000-0000-4000-8000-000000003001";
const USER_ID = "00000000-0000-4000-8000-000000003002";

// Every row shares the default popularity_score of 0, so the default
// popularity sort is one 300-row tie group: without a unique tie-break,
// Postgres may return tied rows in a different order per LIMIT/OFFSET
// query and pages silently drop or repeat rows (#30296).
async function seedCharacters(): Promise<void> {
  await dbWrite.insert(organizations).values({
    id: ORG_ID,
    name: "pagination-org",
    slug: "pagination-org",
  });
  await dbWrite.insert(users).values({
    id: USER_ID,
    organization_id: ORG_ID,
    steward_user_id: "pagination-user",
  });
  const rows = Array.from({ length: ROW_COUNT }, (_, index) => ({
    organization_id: ORG_ID,
    user_id: USER_ID,
    name: `pagetest-${String(index).padStart(3, "0")}`,
    bio: "pagination fixture",
    character_data: {},
    is_public: true,
  }));
  for (let at = 0; at < rows.length; at += 50) {
    await dbWrite.insert(userCharacters).values(rows.slice(at, at + 50));
  }
}

async function walkPages(
  load: (limit: number, offset: number) => Promise<Array<{ id: string }>>,
): Promise<string[]> {
  const seen: string[] = [];
  for (let page = 0; page < ROW_COUNT / PAGE_SIZE; page += 1) {
    const rows = await load(PAGE_SIZE, page * PAGE_SIZE);
    for (const row of rows) seen.push(row.id);
  }
  return seen;
}

let repository: InstanceType<typeof UserCharactersRepository>;

beforeAll(async () => {
  const { apply } = await pushSchema(
    { organizations, users, userCharacters, elizaRoomCharactersTable } as never,
    dbWrite as never,
  );
  await apply();
  repository = new UserCharactersRepository();
  await seedCharacters();
}, TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("character search pagination (real PGlite)", () => {
  test("popularity sort without featured pinning returns every character exactly once", async () => {
    const seen = await walkPages((limit, offset) =>
      repository.search(
        {},
        USER_ID,
        ORG_ID,
        { sortBy: "popularity", order: "desc", pinFeatured: false },
        limit,
        offset,
      ),
    );
    expect(seen).toHaveLength(ROW_COUNT);
    expect(new Set(seen).size).toBe(ROW_COUNT);
  });

  test("the featured-first branch returns every character exactly once", async () => {
    const seen = await walkPages((limit, offset) =>
      repository.search(
        {},
        USER_ID,
        ORG_ID,
        { sortBy: "popularity", order: "desc" },
        limit,
        offset,
      ),
    );
    expect(seen).toHaveLength(ROW_COUNT);
    expect(new Set(seen).size).toBe(ROW_COUNT);
  });

  test("searchPublic returns every character exactly once", async () => {
    const seen = await walkPages((limit, offset) =>
      repository.searchPublic({}, { sortBy: "popularity", order: "desc" }, limit, offset),
    );
    expect(seen).toHaveLength(ROW_COUNT);
    expect(new Set(seen).size).toBe(ROW_COUNT);
  });
});
