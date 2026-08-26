/**
 * Focused correctness test for the documented `metadata` filter on the SQL
 * `getMemories` and `countMemories` paths (issue #29069).
 *
 * The core `IDatabaseAdapter` contract documents `metadata?: Record<string,
 * unknown>` on both reads, and the reference `InMemoryDatabaseAdapter` honors
 * it via `memoryMatchesMetadata` (settled by issue #19089 / PR #19090). The
 * production SQL adapter (`BaseDrizzleAdapter`, used by Pg/PGlite/Neon)
 * previously accepted the key on `getMemories` and dropped it, returning a
 * superset of rows and — because a real consumer
 * (`personality-store.slotFromMemory`) throws on any non-slot row sharing the
 * table — breaking hydration. This pins that `getMemories` now applies JSONB
 * whole-object containment and that `getMemories`/`countMemories` totals cannot
 * drift for the same filter. Runs on PGlite by default; set `POSTGRES_URL` to
 * run against a real Postgres.
 */
import {
  type Entity,
  type Memory,
  type MemoryMetadata,
  MemoryType,
  type UUID,
} from "@elizaos/core";
import { v4 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { embeddingTable, memoryTable } from "../../schema";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

const TABLE = "probe_table";

describe("getMemories/countMemories metadata filter (real SQL adapter)", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let entityId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("memory_metadata_filter");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    entityId = v4() as UUID;
    await adapter.createEntities([
      { id: entityId, agentId: testAgentId, names: ["Metadata Entity"] } as Entity,
    ]);
  });

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    const db = adapter.getDatabase() as DrizzleDatabase;
    await db.delete(embeddingTable);
    await db.delete(memoryTable);
  });

  /** Seed one row in `probe_table` carrying the given (top-level) metadata. */
  const seed = async (metadata: Record<string, unknown>): Promise<void> => {
    const memory: Memory & { metadata: MemoryMetadata } = {
      id: v4() as UUID,
      agentId: testAgentId,
      roomId: undefined,
      entityId,
      content: { text: "probe" },
      createdAt: Date.now(),
      unique: false,
      metadata: { type: MemoryType.CUSTOM, ...metadata } as MemoryMetadata,
    };
    await adapter.createMemory(memory, TABLE);
  };

  const seedFixtures = async (): Promise<void> => {
    await seed({ source: "A" });
    await seed({ source: "B" });
    await seed({ source: "A", extra: 1 });
  };

  const sourcesOf = async (metadata?: Record<string, unknown>): Promise<string[]> => {
    const rows = await adapter.getMemories({
      tableName: TABLE,
      metadata,
      includeEmbedding: false,
    });
    return rows
      .map((row) => (row.metadata as Record<string, unknown>).source)
      .filter((s): s is string => typeof s === "string")
      .sort();
  };

  it("getMemories returns only rows whose metadata contains the filter (superset bug fixed)", async () => {
    await seedFixtures();

    // {source:"A"} matches the plain A row AND {source:"A",extra:1} (containment,
    // not exact-object equality) — exactly the two A rows, never all three.
    expect(await sourcesOf({ source: "A" })).toEqual(["A", "A"]);
    expect(await sourcesOf({ source: "B" })).toEqual(["B"]);
  });

  it("countMemories mirrors getMemories for the same filter (totals cannot drift)", async () => {
    await seedFixtures();

    expect(await adapter.countMemories({ tableName: TABLE, metadata: { source: "A" } })).toBe(2);
    expect(await adapter.countMemories({ tableName: TABLE, metadata: { source: "B" } })).toBe(1);
    // count === length(getMemories) for the identical filter, on both adapters.
    expect(await adapter.countMemories({ tableName: TABLE, metadata: { source: "A" } })).toBe(
      (await sourcesOf({ source: "A" })).length
    );
  });

  it("AND-combines multiple metadata keys (all must be contained)", async () => {
    await seedFixtures();

    // Only the {source:"A",extra:1} row contains both keys.
    expect(await sourcesOf({ source: "A", extra: 1 })).toEqual(["A"]);
    expect(
      await adapter.countMemories({ tableName: TABLE, metadata: { source: "A", extra: 1 } })
    ).toBe(1);
    // A key/value present on no row yields nothing, not a superset.
    expect(await sourcesOf({ source: "Z" })).toEqual([]);
    expect(await adapter.countMemories({ tableName: TABLE, metadata: { source: "Z" } })).toBe(0);
  });

  it("an absent or empty metadata filter is a no-op (no regression)", async () => {
    await seedFixtures();

    expect(await sourcesOf()).toEqual(["A", "A", "B"]);
    expect(await sourcesOf({})).toEqual(["A", "A", "B"]);
    expect(await adapter.countMemories({ tableName: TABLE })).toBe(3);
    expect(await adapter.countMemories({ tableName: TABLE, metadata: {} })).toBe(3);
  });
});
