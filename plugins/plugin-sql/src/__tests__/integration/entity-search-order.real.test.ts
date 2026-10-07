/**
 * `searchEntitiesByName` contract (IDatabaseAdapter): case-insensitive
 * substring match on `names`, exact matches first, at most `limit` rows.
 *
 * Both SQL branches applied LIMIT with no ORDER BY, so the page was whatever
 * physical order the table returned, not a stable "first N". Rows whose
 * physical order differs from creation order (imports, restores, rewrites)
 * expose it. The substring branch also put the raw query into a LIKE
 * pattern, so `%` and `_` acted as wildcards and matched unrelated names.
 */
import type { UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { entityTable } from "../../schema/entity";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("searchEntitiesByName ordering and literal matching", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let agentId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("entity-search-order");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    agentId = setup.testAgentId;
  });

  afterAll(async () => {
    await cleanup?.();
  });

  /**
   * Inserts rows one statement at a time in the given (physical) order with
   * explicit created_at values, so physical order and creation order differ.
   */
  async function insertRows(rows: { names: string[]; minutesAgo: number }[]): Promise<UUID[]> {
    const db = adapter.getDatabase() as DrizzleDatabase;
    const now = Date.now();
    const ids: UUID[] = [];
    for (const row of rows) {
      const id = uuidv4() as UUID;
      await db.insert(entityTable).values({
        id,
        agentId,
        names: row.names,
        createdAt: new Date(now - row.minutesAgo * 60_000),
      });
      ids.push(id);
    }
    return ids;
  }

  it("returns the oldest entities first for an empty query", async () => {
    const [newest, oldest, middle] = await insertRows([
      { names: ["order-newest"], minutesAgo: 10 },
      { names: ["order-oldest"], minutesAgo: 30 },
      { names: ["order-middle"], minutesAgo: 20 },
    ]);

    const page = await adapter.searchEntitiesByName({ query: "", agentId, limit: 2 });

    expect(page.map((e) => e.id)).toEqual([oldest, middle]);
    expect(page.map((e) => e.id)).not.toContain(newest);
  });

  it("returns the oldest matches first for a substring query", async () => {
    const [newest, oldest, middle] = await insertRows([
      { names: ["Probe Newest"], minutesAgo: 10 },
      { names: ["Probe Oldest"], minutesAgo: 30 },
      { names: ["Probe Middle"], minutesAgo: 20 },
    ]);

    const page = await adapter.searchEntitiesByName({ query: "probe", agentId, limit: 2 });

    expect(page.map((e) => e.id)).toEqual([oldest, middle]);
    expect(page.map((e) => e.id)).not.toContain(newest);
  });

  it("returns an exact name match before older partial matches", async () => {
    const [, exact] = await insertRows([
      { names: ["Samwise Gamgee"], minutesAgo: 30 },
      { names: ["Samwise"], minutesAgo: 10 },
    ]);

    const [top] = await adapter.searchEntitiesByName({ query: "SAMWISE", agentId, limit: 1 });

    expect(top?.id).toBe(exact);
  });

  it("treats % and _ in the query as literal characters", async () => {
    const [percent] = await insertRows([
      { names: ["100% Literal"], minutesAgo: 5 },
      { names: ["Underscore Free"], minutesAgo: 5 },
    ]);

    const byPercent = await adapter.searchEntitiesByName({ query: "%", agentId, limit: 50 });
    const byUnderscore = await adapter.searchEntitiesByName({ query: "_", agentId, limit: 50 });

    expect(byPercent.map((e) => e.id)).toEqual([percent]);
    expect(byUnderscore).toEqual([]);
  });
});
