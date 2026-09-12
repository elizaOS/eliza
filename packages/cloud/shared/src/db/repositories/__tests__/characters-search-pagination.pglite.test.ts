/**
 * PGlite proof that character search pagination is total. Every character
 * shares the schema-default popularity_score, so a sort on it alone is a tie
 * across the whole result set; LIMIT/OFFSET over that partial order returns
 * some rows twice and others never. Real repository, real schema pushed from
 * the drizzle definitions, the same page walk the my-agents listing performs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";

const PGLITE_DATABASE_URL = "pglite://memory";
const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  MOCK_REDIS: process.env.MOCK_REDIS,
  SKIP_AGENT_SANDBOX_ENSURE: process.env.SKIP_AGENT_SANDBOX_ENSURE,
};
// Force both selectors before the client is imported so an ambient
// integration DSN can never receive this suite's DDL.
process.env.DATABASE_URL = PGLITE_DATABASE_URL;
process.env.TEST_DATABASE_URL = PGLITE_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { elizaRoomCharactersTable } from "../../schemas/eliza-room-characters";
import { organizations } from "../../schemas/organizations";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";

type ClientModule = typeof import("../../client");
type CharactersModule = typeof import("../characters");
type Search = CharactersModule["UserCharactersRepository"]["prototype"]["search"];

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000001";
const TOTAL = 300;
const PAGE = 30;

let dbWrite: ClientModule["dbWrite"];
let closeDatabaseConnectionsForTests: ClientModule["closeDatabaseConnectionsForTests"] | undefined;
let search: Search;
let schemaFailure = "";

beforeAll(async () => {
  try {
    const [clientModule, charactersModule] = await Promise.all([
      import("../../client"),
      import("../characters"),
    ]);
    dbWrite = clientModule.dbWrite;
    closeDatabaseConnectionsForTests = clientModule.closeDatabaseConnectionsForTests;
    const repository = charactersModule.userCharactersRepository;
    search = repository.search.bind(repository);
    const { apply } = await pushSchema(
      { organizations, users, userCharacters, elizaRoomCharactersTable } as never,
      dbWrite as never,
    );
    await apply();
    await dbWrite.insert(organizations).values({
      id: ORGANIZATION_ID,
      name: "Pagination org",
      slug: "pagination-org",
    });
    await dbWrite.insert(users).values({
      id: USER_ID,
      steward_user_id: "pagination-user",
      organization_id: ORGANIZATION_ID,
    });
    for (let i = 0; i < TOTAL; i += 1) {
      await dbWrite.insert(userCharacters).values({
        organization_id: ORGANIZATION_ID,
        user_id: USER_ID,
        name: `character-${String(i).padStart(3, "0")}`,
        bio: "tied on the default popularity score",
        character_data: {},
      });
    }
  } catch (error) {
    schemaFailure = error instanceof Error ? error.message : String(error);
  }
}, 120_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function walkPages(sort: Parameters<Search>[3]): Promise<Map<string, number>> {
  const seen = new Map<string, number>();
  for (let offset = 0; offset < TOTAL; offset += PAGE) {
    const rows = await search({}, USER_ID, ORGANIZATION_ID, sort, PAGE, offset);
    for (const row of rows) seen.set(row.id, (seen.get(row.id) ?? 0) + 1);
  }
  return seen;
}

describe("character search pagination is a total order", () => {
  test("popularity sort without featured pinning returns every character exactly once", async () => {
    expect(schemaFailure).toBe("");
    const seen = await walkPages({ sortBy: "popularity", order: "desc", pinFeatured: false });
    expect(seen.size).toBe(TOTAL);
    expect([...seen.values()].filter((count) => count > 1)).toHaveLength(0);
  });

  test("the featured-first branch returns every character exactly once", async () => {
    expect(schemaFailure).toBe("");
    const seen = await walkPages({ sortBy: "popularity", order: "desc" });
    expect(seen.size).toBe(TOTAL);
    expect([...seen.values()].filter((count) => count > 1)).toHaveLength(0);
  });
});
