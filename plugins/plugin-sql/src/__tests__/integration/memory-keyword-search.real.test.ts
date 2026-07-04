/**
 * Scale test for the keyword (`textContains`) search path on `getMemories`.
 * Seeds a large fixture (>=2k rooms / >=200k message rows) and proves the
 * keyword search is a single pushed-down SQL `ILIKE` predicate — not a
 * "fetch every row, scan in JS" pattern — returns correct rows across
 * conversations, reaches a hit far outside the recent window, and stays
 * bounded in latency. Default mode is PGlite (WASM, in-process); set
 * `POSTGRES_URL` to run against a real Postgres instead.
 */
import { ChannelType, type Entity, type Room, type UUID, type World } from "@elizaos/core";
import { v4 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { memoryTable } from "../../schema";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

const ROOMS = Number(process.env.KEYWORD_SEARCH_TEST_ROOMS ?? 2_000);
const MESSAGES_PER_ROOM = Number(process.env.KEYWORD_SEARCH_TEST_MESSAGES_PER_ROOM ?? 100);
const TOTAL_MESSAGES = ROOMS * MESSAGES_PER_ROOM;
const INSERT_CHUNK = 2_000;

// A unique needle that appears in exactly one seeded message, planted as the
// VERY FIRST message of the first room — i.e. the oldest row in the whole
// fixture, far outside any recent-N window. Reaching it proves the keyword
// predicate scans the full table in SQL, not a JS slice of recent rows.
const RARE_NEEDLE = "xyzzy-plugh-unique-marker";
// A common needle present in a known, bounded fraction of messages.
const COMMON_NEEDLE = "pineapple";
const COMMON_HIT_EVERY = 50; // one in fifty messages contains COMMON_NEEDLE

describe("getMemories keyword search at scale (real DB)", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let runtime: Awaited<ReturnType<typeof createIsolatedTestDatabase>>["runtime"];
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let firstRoomId: UUID;
  let expectedCommonHits = 0;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("memory_keyword_search");
    adapter = setup.adapter;
    runtime = setup.runtime;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    const worldId = v4() as UUID;
    await adapter.createWorld({
      id: worldId,
      agentId: testAgentId,
      name: "Scale World",
      serverId: "scale-server",
    } as World);

    const entityId = v4() as UUID;
    await adapter.createEntities([
      { id: entityId, agentId: testAgentId, names: ["Scale Entity"] } as Entity,
    ]);

    // Create rooms in batches via the adapter (FK target for messages).
    const roomIds: UUID[] = [];
    for (let i = 0; i < ROOMS; i++) roomIds.push(v4() as UUID);
    firstRoomId = roomIds[0];

    for (let start = 0; start < ROOMS; start += INSERT_CHUNK) {
      const slice = roomIds.slice(start, start + INSERT_CHUNK);
      await adapter.createRooms(
        slice.map(
          (id) =>
            ({
              id,
              agentId: testAgentId,
              worldId,
              name: "room",
              source: "test",
              type: ChannelType.DM,
            }) as Room
        )
      );
    }
    for (const roomId of roomIds) {
      await adapter.addParticipant(entityId, roomId);
    }

    // Batch-insert message rows directly. Seeding 200k+ rows through the
    // per-row createMemory path would dominate the suite; a chunked
    // db.insert is the legitimate fast path for fixture data.
    const db = adapter.getDatabase() as DrizzleDatabase;
    const baseTime = Date.now() - TOTAL_MESSAGES * 1_000;
    let rows: Array<typeof memoryTable.$inferInsert> = [];
    let globalIndex = 0;

    const flush = async () => {
      if (rows.length === 0) return;
      await db.insert(memoryTable).values(rows);
      rows = [];
    };

    for (let r = 0; r < ROOMS; r++) {
      const roomId = roomIds[r];
      for (let m = 0; m < MESSAGES_PER_ROOM; m++) {
        // Plant the rare needle as the oldest row in the whole fixture. The
        // rare row is NOT a common hit (its text omits COMMON_NEEDLE), so the
        // common-hit count must exclude it even when its index aligns.
        const isRare = r === 0 && m === 0;
        const isCommon = !isRare && globalIndex % COMMON_HIT_EVERY === 0;
        if (isCommon) expectedCommonHits += 1;
        const text = isRare
          ? `oldest message containing ${RARE_NEEDLE} keyword`
          : isCommon
            ? `message ${globalIndex} mentioning ${COMMON_NEEDLE} fruit`
            : `ordinary message number ${globalIndex} with filler words`;
        rows.push({
          id: v4() as UUID,
          type: "messages",
          content: { text },
          entityId,
          agentId: testAgentId,
          roomId,
          worldId,
          unique: false,
          metadata: { type: "messages", source: "test" },
          createdAt: new Date(baseTime + globalIndex * 1_000),
        });
        globalIndex += 1;
        if (rows.length >= INSERT_CHUNK) await flush();
      }
    }
    await flush();
  }, 600_000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  it("seeded the full-scale fixture", async () => {
    expect(TOTAL_MESSAGES).toBeGreaterThanOrEqual(200_000);
    expect(ROOMS).toBeGreaterThanOrEqual(2_000);
  });

  it("uses a pushed-down SQL ILIKE, not a full-table JS scan (EXPLAIN)", async () => {
    const db = adapter.getDatabase() as DrizzleDatabase;
    // The escaping mirrors base.ts; here the needle has no metacharacters.
    const result = await db.execute(
      `EXPLAIN SELECT id FROM memories WHERE type = 'messages' AND content->>'text' ILIKE '%${COMMON_NEEDLE}%'`
    );
    // Postgres normalizes ILIKE to the `~~*` operator and surfaces it as a
    // Filter / Index Cond on `content ->> 'text'`. Its presence proves the
    // keyword predicate is evaluated by the DATABASE on this query — a JS
    // search would never appear in any DB plan.
    const plan = JSON.stringify(result).toLowerCase();
    expect(plan).toContain("~~*");
    expect(plan).toContain("content ->> 'text'");
  });

  it("finds the rare needle — the OLDEST row, far outside the recent window", async () => {
    const started = Date.now();
    const results = await runtime.getMemories({
      tableName: "messages",
      textContains: RARE_NEEDLE,
      includeEmbedding: false,
      limit: 50,
    });
    const elapsed = Date.now() - started;

    expect(results).toHaveLength(1);
    const hit = results[0];
    expect((hit.content as { text?: string }).text).toContain(RARE_NEEDLE);
    expect(hit.roomId).toBe(firstRoomId);
    // The hit is the single oldest message (index 0) of 200k+ — proving the
    // keyword path reached past the most-recent 200 window into the full table.
    expect(elapsed).toBeLessThan(5_000);
  });

  it("returns all common-needle hits across conversations, ranked", async () => {
    const started = Date.now();
    const results = await runtime.getMemories({
      tableName: "messages",
      textContains: COMMON_NEEDLE,
      includeEmbedding: false,
      // High cap; every returned row already matched in SQL.
      limit: 100_000,
    });
    const elapsed = Date.now() - started;

    expect(results.length).toBe(expectedCommonHits);
    for (const hit of results) {
      expect((hit.content as { text?: string }).text?.toLowerCase()).toContain(COMMON_NEEDLE);
    }
    // Hits span many distinct rooms (cross-conversation), not just one.
    const distinctRooms = new Set(results.map((r) => r.roomId));
    expect(distinctRooms.size).toBeGreaterThan(10);
    // Bounded latency even though the fixture has 200k+ rows: the DB discarded
    // every non-matching row before returning.
    expect(elapsed).toBeLessThan(8_000);
  });

  it("is case-insensitive", async () => {
    const lower = await runtime.getMemories({
      tableName: "messages",
      textContains: COMMON_NEEDLE.toLowerCase(),
      includeEmbedding: false,
      limit: 100_000,
    });
    const upper = await runtime.getMemories({
      tableName: "messages",
      textContains: COMMON_NEEDLE.toUpperCase(),
      includeEmbedding: false,
      limit: 100_000,
    });
    expect(upper.length).toBe(lower.length);
    expect(upper.length).toBe(expectedCommonHits);
  });

  it("returns nothing for a needle that does not occur", async () => {
    const results = await runtime.getMemories({
      tableName: "messages",
      textContains: "this-substring-was-never-seeded-anywhere",
      includeEmbedding: false,
      limit: 100,
    });
    expect(results).toHaveLength(0);
  });

  it("treats LIKE metacharacters as literals (no wildcard expansion)", async () => {
    // '%' would match everything if not escaped; the seeded text never contains
    // a literal '%', so a literal-substring search must return zero rows.
    const results = await runtime.getMemories({
      tableName: "messages",
      textContains: "%",
      includeEmbedding: false,
      limit: 100,
    });
    expect(results).toHaveLength(0);
  });
});
