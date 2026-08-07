/**
 * Integration proof that `searchMemoriesByEmbedding`'s post-LIMIT similarity
 * threshold returns the byte-identical result set (ids, order, similarity) as
 * the previous threshold-in-WHERE query shape, against a real isolated
 * PGlite/Postgres adapter. The threshold predicate is monotone in the ORDER BY
 * key (similarity >= T is distance <= 1 - T), so every passing row is a prefix
 * of the distance-ordered eligible sequence — filtering the top K after the
 * LIMIT can neither drop nor add a row. The in-WHERE form is replayed here as
 * raw SQL to pin that equivalence for plentiful, sparse, and no-match corpora,
 * plus the unchanged scope-in-WHERE and zero/absent-threshold contracts.
 */
import { ChannelType, type Memory, type Room, type UUID, type World } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { v4 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { getDb } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

const DIMS = 384;
const TABLE = "threshold-postfilter";

/** Unit vector at an exact cosine similarity to the query axis `e0`. */
function vectorAtSimilarity(similarity: number): number[] {
  const rest = Math.sqrt(Math.max(0, 1 - similarity * similarity));
  return Array.from({ length: DIMS }, (_, i) => {
    if (i === 0) return similarity;
    if (i === 1) return rest;
    return 0;
  });
}

const QUERY = vectorAtSimilarity(1);

/** Exact cosine similarities seeded into the corpus (all distinct, so both
 * query shapes have one deterministic order). Six rows sit at or above 0.7. */
const SEEDED_SIMILARITIES = [0.98, 0.95, 0.9, 0.85, 0.8, 0.72, 0.65, 0.6, 0.5, 0.35, 0.2, 0.05];

describe("searchMemoriesByEmbedding threshold post-filter (query-shape identity)", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let roomId: UUID;
  let entityId: UUID;
  const idBySimilarity = new Map<number, UUID>();

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("threshold_postfilter");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    const worldId = v4() as UUID;
    roomId = v4() as UUID;
    entityId = v4() as UUID;
    await adapter.createWorld({
      id: worldId,
      agentId: testAgentId,
      name: "Threshold World",
      serverId: "threshold-server",
    } as World);
    await adapter.createRooms([
      {
        id: roomId,
        agentId: testAgentId,
        worldId,
        name: "Threshold Room",
        source: "test",
        type: ChannelType.GROUP,
      } as Room,
    ]);
    await adapter.createEntities([
      { id: entityId, agentId: testAgentId, names: ["Threshold Entity"] },
    ]);

    for (const similarity of SEEDED_SIMILARITIES) {
      const id = v4() as UUID;
      idBySimilarity.set(similarity, id);
      await adapter.createMemory(
        {
          id,
          content: { text: `corpus row at similarity ${similarity}` },
          createdAt: Date.now(),
          embedding: vectorAtSimilarity(similarity),
          agentId: testAgentId,
          roomId,
          entityId,
          unique: false,
        } as Memory,
        TABLE
      );
    }
  }, 60_000);

  afterAll(async () => {
    await cleanup();
  });

  /** The previous adapter query shape — similarity floor inside the WHERE of
   * the ordered scan — replayed verbatim as the baseline oracle. */
  async function baselineThresholdInWhere(
    threshold: number,
    limit: number
  ): Promise<Array<{ id: string; similarity: number }>> {
    const vec = `[${QUERY.join(",")}]`;
    const result = await getDb(adapter).execute(
      sql.raw(
        `SELECT m.id AS id, 1 - (e.dim_384 <=> '${vec}'::vector) AS similarity ` +
          `FROM embeddings e JOIN memories m ON m.id = e.memory_id ` +
          `WHERE e.dim_384 IS NOT NULL AND m.type = '${TABLE}' AND m.agent_id = '${testAgentId}' ` +
          `AND 1 - (e.dim_384 <=> '${vec}'::vector) >= ${threshold} ` +
          `ORDER BY e.dim_384 <=> '${vec}'::vector ASC LIMIT ${limit}`
      )
    );
    const rows = Array.isArray(result) ? result : (result.rows ?? []);
    return rows.map((row) => {
      const record = row as { id: string; similarity: number | string };
      return { id: record.id, similarity: Number(record.similarity) };
    });
  }

  async function searchWithThreshold(threshold: number | undefined, limit: number) {
    return adapter.searchMemoriesByEmbedding(QUERY, {
      tableName: TABLE,
      count: limit,
      ...(threshold === undefined ? {} : { match_threshold: threshold }),
    });
  }

  it("matches the threshold-in-WHERE baseline when more rows pass than the limit (plentiful)", async () => {
    const limit = 4;
    const current = await searchWithThreshold(0.7, limit);
    const baseline = await baselineThresholdInWhere(0.7, limit);

    expect(current.map((m) => m.id)).toEqual(baseline.map((row) => row.id));
    expect(current).toHaveLength(limit);
    current.forEach((memory, i) => {
      expect(memory.similarity ?? 0).toBeCloseTo(baseline[i].similarity, 10);
    });
  });

  it("matches the baseline when fewer rows pass than the limit (sparse)", async () => {
    const limit = 10;
    const current = await searchWithThreshold(0.7, limit);
    const baseline = await baselineThresholdInWhere(0.7, limit);

    // Exactly the six seeded rows at similarity >= 0.7, in descending order.
    expect(current.map((m) => m.id)).toEqual(baseline.map((row) => row.id));
    expect(current.map((m) => m.id)).toEqual(
      [0.98, 0.95, 0.9, 0.85, 0.8, 0.72].map((s) => idBySimilarity.get(s))
    );
    for (const memory of current) {
      expect(memory.similarity ?? 0).toBeGreaterThanOrEqual(0.7);
    }
  });

  it("matches the baseline when nothing passes the threshold (no-match turn)", async () => {
    const current = await searchWithThreshold(0.99, 10);
    const baseline = await baselineThresholdInWhere(0.99, 10);

    expect(current).toEqual([]);
    expect(baseline).toEqual([]);
  });

  it("applies no similarity floor when match_threshold is absent or zero (unchanged truthiness contract)", async () => {
    const absent = await searchWithThreshold(undefined, SEEDED_SIMILARITIES.length);
    expect(absent).toHaveLength(SEEDED_SIMILARITIES.length);

    const zero = await searchWithThreshold(0, SEEDED_SIMILARITIES.length);
    expect(zero.map((m) => m.id)).toEqual(absent.map((m) => m.id));
  });

  it("keeps scope predicates inside the ordered scan (no starvation from closer out-of-scope rows)", async () => {
    // Plant closer vectors in ANOTHER room; a room-scoped search must still
    // surface this room's row rather than starving on the global top-K.
    const otherRoomId = v4() as UUID;
    await adapter.createRooms([
      {
        id: otherRoomId,
        agentId: testAgentId,
        name: "Other Room",
        source: "test",
        type: ChannelType.GROUP,
      } as Room,
    ]);
    for (let i = 0; i < 20; i++) {
      await adapter.createMemory(
        {
          id: v4() as UUID,
          content: { text: `closer out-of-scope ${i}` },
          createdAt: Date.now(),
          embedding: vectorAtSimilarity(0.999),
          agentId: testAgentId,
          roomId: otherRoomId,
          entityId,
          unique: false,
        } as Memory,
        TABLE
      );
    }

    const scoped = await adapter.searchMemoriesByEmbedding(QUERY, {
      tableName: TABLE,
      roomId,
      count: 1,
      match_threshold: 0.7,
    });
    expect(scoped.map((m) => m.id)).toEqual([idBySimilarity.get(0.98)]);
  });
});
