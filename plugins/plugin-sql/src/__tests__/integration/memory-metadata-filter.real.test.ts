/**
 * Conformance test for the documented `metadata` filter on the SQL
 * `getMemories` and `countMemories` paths (issue #29069).
 *
 * The core `IDatabaseAdapter` contract documents `metadata?: Record<string,
 * unknown>` on both reads, and the reference `InMemoryDatabaseAdapter` honors
 * it via `memoryMatchesMetadata` (settled by issue #19089 / PR #19090): each
 * requested top-level key must be present and its value must equal the stored
 * value. The production SQL adapter (`BaseDrizzleAdapter`, used by
 * Pg/PGlite/Neon) previously accepted the key on `getMemories` and dropped it,
 * returning a superset of rows and \u2014 because a real consumer
 * (`personality-store.slotFromMemory`) throws on any non-slot row sharing the
 * table \u2014 breaking hydration.
 *
 * This runs one shared filter matrix against the real SQL adapter and pins the
 * reference-aligned semantics: per-top-level JSON value equality, NOT `@>`
 * whole-object containment. In particular nested-object and array supersets
 * (`{tags:["a","b"]}` under filter `{tags:["a"]}`) must NOT match, which is
 * exactly where recursive `@>` containment would diverge from the reference
 * adapter. `getMemories`/`countMemories` totals must agree for every filter.
 * Runs on PGlite by default; set `POSTGRES_URL` to run against a real Postgres.
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

/**
 * Fixtures carry a unique `label` (for identification) plus the metadata under
 * test. Sources intentionally repeat so the matrix exercises multi-row filters.
 */
const FIXTURES: Array<{ label: string; metadata: Record<string, unknown> }> = [
  { label: "L1", metadata: { source: "A" } },
  { label: "L2", metadata: { source: "B" } },
  { label: "L3", metadata: { source: "A", extra: 1 } },
  { label: "L4", metadata: { profile: { tone: "warm", extra: 1 } } },
  { label: "L5", metadata: { tags: ["a", "b"] } },
  { label: "L6", metadata: { note: null } },
];

/**
 * Each case names the requested filter and the labels that must be returned
 * under reference top-level-equality semantics. `undefined` marks a no-op
 * (absent/empty) filter that returns every row.
 */
const CASES: Array<{
  name: string;
  filter?: Record<string, unknown>;
  expected: string[];
}> = [
  {
    name: "absent filter is a no-op",
    filter: undefined,
    expected: ["L1", "L2", "L3", "L4", "L5", "L6"],
  },
  { name: "empty filter is a no-op", filter: {}, expected: ["L1", "L2", "L3", "L4", "L5", "L6"] },
  { name: "scalar matches all containing rows", filter: { source: "A" }, expected: ["L1", "L3"] },
  { name: "scalar single match", filter: { source: "B" }, expected: ["L2"] },
  { name: "multi-key AND", filter: { source: "A", extra: 1 }, expected: ["L3"] },
  {
    name: "no-match scalar returns nothing (not a superset)",
    filter: { source: "Z" },
    expected: [],
  },
  // Reference alignment: nested-object and array supersets must NOT match.
  {
    name: "nested-object superset does NOT match (@> would)",
    filter: { profile: { tone: "warm" } },
    expected: [],
  },
  {
    name: "nested-object exact match",
    filter: { profile: { tone: "warm", extra: 1 } },
    expected: ["L4"],
  },
  {
    name: "nested-object reordered keys still match (canonical equality)",
    filter: { profile: { extra: 1, tone: "warm" } },
    expected: ["L4"],
  },
  { name: "array superset does NOT match (@> would)", filter: { tags: ["a"] }, expected: [] },
  { name: "array exact match", filter: { tags: ["a", "b"] }, expected: ["L5"] },
  { name: "array wrong order does NOT match", filter: { tags: ["b", "a"] }, expected: [] },
  // Null vs missing: present-null matches only a present-null; a filter for a
  // key absent on every row (or present as a non-null value) matches nothing.
  { name: "present-null value matches", filter: { note: null }, expected: ["L6"] },
  {
    name: "null filter on a non-null/absent key matches nothing",
    filter: { source: null },
    expected: [],
  },
  // undefined is unsatisfiable (no match), never a backend-dependent no-op.
  { name: "undefined value matches nothing", filter: { source: undefined }, expected: [] },
  {
    name: "undefined alongside a real key matches nothing",
    filter: { source: "A", extra: undefined },
    expected: [],
  },
];

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
    for (const fixture of FIXTURES) {
      const memory: Memory & { metadata: MemoryMetadata } = {
        id: v4() as UUID,
        agentId: testAgentId,
        roomId: undefined,
        entityId,
        content: { text: "probe" },
        createdAt: Date.now(),
        unique: false,
        metadata: {
          type: MemoryType.CUSTOM,
          label: fixture.label,
          ...fixture.metadata,
        } as MemoryMetadata,
      };
      await adapter.createMemory(memory, TABLE);
    }
  });

  const labelsOf = async (metadata?: Record<string, unknown>): Promise<string[]> => {
    const rows = await adapter.getMemories({
      tableName: TABLE,
      metadata,
      includeEmbedding: false,
    });
    return rows
      .map((row) => (row.metadata as Record<string, unknown>).label)
      .filter((l): l is string => typeof l === "string")
      .sort();
  };

  for (const testCase of CASES) {
    it(`getMemories: ${testCase.name}`, async () => {
      expect(await labelsOf(testCase.filter)).toEqual([...testCase.expected].sort());
    });

    it(`countMemories mirrors getMemories: ${testCase.name}`, async () => {
      const count = await adapter.countMemories({ tableName: TABLE, metadata: testCase.filter });
      // count must equal both the expected total and the actual getMemories length,
      // so the two SQL paths cannot drift for any filter shape.
      expect(count).toBe(testCase.expected.length);
      expect(count).toBe((await labelsOf(testCase.filter)).length);
    });
  }
});
