/**
 * PGlite page walks over the character search queries, proving their ORDER BY
 * is a total order for a dataset that does not change between pages. Every
 * character shares the schema-default popularity_score, so a sort on it alone
 * ties across the whole result set and LIMIT/OFFSET over that partial order
 * returns some rows twice and others never. Real repository, real schema
 * pushed from the drizzle definitions: the my-agents walk over both search()
 * branches, and the public catalog walk over searchPublic() with its
 * visibility and filter contract. Deterministic page boundaries for a stable
 * dataset are the claim; snapshot consistency across concurrent inserts,
 * deletes, or primary-sort changes is not.
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
import { type NewUserCharacter, userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";

type ClientModule = typeof import("../../client");
type CharactersModule = typeof import("../characters");
type Repository = CharactersModule["UserCharactersRepository"]["prototype"];
type Search = Repository["search"];
type SearchPublic = Repository["searchPublic"];
type CountPublic = Repository["countPublic"];
type PublicFilters = Parameters<SearchPublic>[0];

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000001";
const CATALOG_USER_ID = "20000000-0000-4000-8000-000000000002";
const PRIVATE_TOTAL = 300;
const PUBLIC_TOTAL = 200;
const TEMPLATE_TOTAL = 100;
const FEATURED_EVERY = 25;
const PAGE = 30;
const INSERT_CHUNK = 100;
const PUBLIC_SORT = { sortBy: "popularity", order: "desc" } as const;

let dbWrite: ClientModule["dbWrite"];
let closeDatabaseConnectionsForTests: ClientModule["closeDatabaseConnectionsForTests"] | undefined;
let search: Search;
let searchPublic: SearchPublic;
let countPublic: CountPublic;
let schemaFailure = "";
const privateIds = new Set<string>();
const publicIds = new Set<string>();
const templateIds = new Set<string>();
const featuredCatalogIds = new Set<string>();

function character(
  userId: string,
  label: string,
  index: number,
  overrides: Partial<NewUserCharacter>,
): NewUserCharacter {
  return {
    organization_id: ORGANIZATION_ID,
    user_id: userId,
    name: `${label}-${String(index).padStart(3, "0")}`,
    bio: "tied on the default popularity score",
    character_data: {},
    featured: index % FEATURED_EVERY === 0,
    ...overrides,
  };
}

async function seed(rows: NewUserCharacter[], ids: Set<string>, featuredIds?: Set<string>) {
  for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
    const inserted = await dbWrite
      .insert(userCharacters)
      .values(rows.slice(start, start + INSERT_CHUNK))
      .returning({ id: userCharacters.id, featured: userCharacters.featured });
    for (const row of inserted) {
      ids.add(row.id);
      if (row.featured) featuredIds?.add(row.id);
    }
  }
}

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
    searchPublic = repository.searchPublic.bind(repository);
    countPublic = repository.countPublic.bind(repository);
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
    await dbWrite.insert(users).values([
      { id: USER_ID, steward_user_id: "pagination-user", organization_id: ORGANIZATION_ID },
      { id: CATALOG_USER_ID, steward_user_id: "catalog-user", organization_id: ORGANIZATION_ID },
    ]);
    // Private rows include featured ones so the featured-first public order
    // cannot leak a private character into the catalog walk.
    await seed(
      Array.from({ length: PRIVATE_TOTAL }, (_, i) => character(USER_ID, "private", i, {})),
      privateIds,
    );
    await seed(
      Array.from({ length: PUBLIC_TOTAL }, (_, i) =>
        character(CATALOG_USER_ID, "public", i, { is_public: true }),
      ),
      publicIds,
      featuredCatalogIds,
    );
    await seed(
      Array.from({ length: TEMPLATE_TOTAL }, (_, i) =>
        character(CATALOG_USER_ID, "template", i, { is_template: true }),
      ),
      templateIds,
      featuredCatalogIds,
    );
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

function tally(seen: Map<string, number>, ids: Iterable<string>) {
  for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
}

function duplicates(seen: Map<string, number>): string[] {
  return [...seen].filter(([, count]) => count > 1).map(([id]) => id);
}

async function walkSearch(sort: Parameters<Search>[3]): Promise<Map<string, number>> {
  const seen = new Map<string, number>();
  for (let offset = 0; offset < PRIVATE_TOTAL; offset += PAGE) {
    const rows = await search({}, USER_ID, ORGANIZATION_ID, sort, PAGE, offset);
    tally(
      seen,
      rows.map((row) => row.id),
    );
  }
  return seen;
}

/**
 * Walks the public catalog the way a paginating caller does: countPublic
 * bounds the page count and searchPublic serves each page.
 */
async function walkPublic(
  filters: PublicFilters,
): Promise<{ total: number; order: string[]; seen: Map<string, number> }> {
  const total = Number(await countPublic(filters));
  const order: string[] = [];
  const seen = new Map<string, number>();
  for (let offset = 0; offset < total; offset += PAGE) {
    const rows = await searchPublic(filters, PUBLIC_SORT, PAGE, offset);
    const ids = rows.map((row) => row.id);
    order.push(...ids);
    tally(seen, ids);
  }
  return { total, order, seen };
}

describe("character search pagination is a total order", () => {
  test("popularity sort without featured pinning returns every character exactly once", async () => {
    expect(schemaFailure).toBe("");
    const seen = await walkSearch({ sortBy: "popularity", order: "desc", pinFeatured: false });
    expect(seen.size).toBe(PRIVATE_TOTAL);
    expect(duplicates(seen)).toHaveLength(0);
  });

  test("the featured-first branch returns every character exactly once", async () => {
    expect(schemaFailure).toBe("");
    const seen = await walkSearch({ sortBy: "popularity", order: "desc" });
    expect(seen.size).toBe(PRIVATE_TOTAL);
    expect(duplicates(seen)).toHaveLength(0);
  });
});

describe("public character search pagination is a total order", () => {
  test("returns every public or template character exactly once and never a private one", async () => {
    expect(schemaFailure).toBe("");
    const visible = new Set([...publicIds, ...templateIds]);
    const { total, order, seen } = await walkPublic({});
    expect(total).toBe(PUBLIC_TOTAL + TEMPLATE_TOTAL);
    expect(seen.size).toBe(visible.size);
    expect(duplicates(seen)).toHaveLength(0);
    expect([...seen.keys()].filter((id) => privateIds.has(id))).toHaveLength(0);
    expect([...seen.keys()].filter((id) => !visible.has(id))).toHaveLength(0);
    // featured DESC leads the catalog order, so the walk opens with exactly
    // the featured catalog rows before any unfeatured one.
    expect(new Set(order.slice(0, featuredCatalogIds.size))).toEqual(featuredCatalogIds);
  });

  test("template and featured filters still narrow the walk under the total order", async () => {
    expect(schemaFailure).toBe("");
    const templates = await walkPublic({ template: true });
    expect(templates.total).toBe(TEMPLATE_TOTAL);
    expect(templates.seen.size).toBe(TEMPLATE_TOTAL);
    expect(new Set(templates.seen.keys())).toEqual(templateIds);
    expect(duplicates(templates.seen)).toHaveLength(0);

    const featured = await walkPublic({ featured: true });
    expect(featured.total).toBe(featuredCatalogIds.size);
    expect(new Set(featured.seen.keys())).toEqual(featuredCatalogIds);
    expect(duplicates(featured.seen)).toHaveLength(0);
  });
});
