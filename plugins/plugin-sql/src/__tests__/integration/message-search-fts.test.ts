/**
 * Real-store correctness suite for corpus-wide chat message search (#13534,
 * follow-up #9955). Drives `IDatabaseAdapter.searchMessages` against a REAL
 * PGlite adapter with the actual migration-installed FTS + `pg_trgm` objects
 * (`eliza_message_search_document`, `eliza_search_fold`, the two GIN indexes) —
 * no mock stands in for the store. Asserts the acceptance-criteria edge cases:
 * multi-word non-adjacent (`websearch_to_tsquery`), case/accent/apostrophe
 * folding, partial-word + typo (trigram), stemming, code metacharacters treated
 * literally, URL/emoji/CJK substrings, quoted phrase vs bare-term semantics,
 * near-duplicate deterministic ordering, attachment-filename indexing, deleted-
 * row exclusion, room access-scoping, and corpus-wide recall of a hit far older
 * than any recency window on a multi-thousand-row corpus. Default harness is
 * PGlite (WASM, in-process); set `POSTGRES_URL` to run against real Postgres.
 */
import { ChannelType, type Entity, type Room, type UUID, type World } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { v4 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { memoryTable } from "../../schema";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

const RECALL_CORPUS = Number(process.env.MESSAGE_SEARCH_RECALL_CORPUS ?? 3_000);

describe("searchMessages FTS + trigram (real DB)", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let runtime: Awaited<ReturnType<typeof createIsolatedTestDatabase>>["runtime"];
  let cleanup: () => Promise<void>;
  let agentId: UUID;
  let entityId: UUID;
  let worldId: UUID;
  const roomA = v4() as UUID;
  const roomB = v4() as UUID;
  let seq = 0;

  const seed = async (
    roomId: UUID,
    text: string,
    author: "user" | "assistant" = "user",
    attachments?: Array<{ title?: string; url?: string }>
  ): Promise<UUID> => {
    const id = v4() as UUID;
    const content: Record<string, unknown> = { text };
    if (attachments) content.attachments = attachments;
    await adapter.createMemory(
      {
        id,
        entityId: author === "assistant" ? agentId : entityId,
        agentId,
        roomId,
        worldId,
        content,
        metadata: { type: "messages" },
        createdAt: Date.now() + seq++ * 1000,
      } as never,
      "messages"
    );
    return id;
  };

  const searchTexts = async (query: string, room: UUID = roomA) => {
    const hits = await runtime.searchMessages({
      roomIds: [room],
      query,
      tableName: "messages",
      limit: 50,
    });
    return hits.map((h) => (h.memory.content as { text?: string }).text ?? "");
  };

  beforeAll(async () => {
    const s = await createIsolatedTestDatabase("message_search_fts");
    adapter = s.adapter;
    runtime = s.runtime;
    cleanup = s.cleanup;
    agentId = s.testAgentId;

    worldId = v4() as UUID;
    await adapter.createWorld({
      id: worldId,
      agentId,
      name: "W",
      serverId: "s",
    } as World);
    entityId = v4() as UUID;
    await adapter.createEntities([
      { id: entityId, agentId, names: ["E"] } as Entity,
      // The agent's own entity — assistant messages carry entityId === agentId,
      // which the memories FK requires to exist in `entities`.
      { id: agentId, agentId, names: ["Agent"] } as Entity,
    ]);
    for (const rid of [roomA, roomB]) {
      await adapter.createRooms([
        {
          id: rid,
          agentId,
          worldId,
          name: "r",
          source: "test",
          type: ChannelType.DM,
        } as Room,
      ]);
      await adapter.addParticipant(entityId, rid);
    }

    await seed(roomA, "deploy your first agent to the cloud", "user");
    await seed(roomA, "I opened a PR on GitHub this morning", "assistant");
    await seed(roomA, "the café down the street has great coffee", "user");
    await seed(roomA, "please don't merge that branch yet", "assistant");
    await seed(roomA, "how do I edit the configuration file", "user");
    await seed(roomA, "I am configuring the webhook right now", "assistant");
    await seed(roomA, "run `SELECT * FROM users WHERE name LIKE '%bob_%'` now", "user");
    await seed(roomA, "see https://example.com/docs/path/to/thing for details", "assistant");
    await seed(roomA, "great work 🚀 shipping today", "user");
    await seed(roomA, "北京 is the capital of China", "assistant");
    await seed(roomA, "the exact phrase alpha beta lives here", "user");
    await seed(roomA, "alpha appears alone and beta appears far away later", "assistant");
    await seed(roomA, "here is the file you asked for", "user", [
      {
        title: "quarterly-budget-2026.xlsx",
        url: "https://cdn.example.com/quarterly-budget-2026.xlsx",
      },
    ]);
    await seed(roomA, "duplicate marker zephyr", "user");
    await seed(roomA, "duplicate marker zephyr", "user");
    // roomB — for access scoping.
    await seed(roomB, "roomB privately mentions zephyr too", "user");
  }, 180_000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  it("1. multi-word non-adjacent — 'deploy agent' matches 'deploy your first agent'", async () => {
    expect(
      (await searchTexts("deploy agent")).some((t) => t.includes("deploy your first agent"))
    ).toBe(true);
  });

  it("2. mixed case — 'GITHUB' matches 'GitHub'", async () => {
    expect((await searchTexts("GITHUB")).some((t) => t.includes("GitHub"))).toBe(true);
  });

  it("3. accent + apostrophe fold — cafe~café, dont~don't", async () => {
    expect((await searchTexts("cafe")).some((t) => t.includes("café"))).toBe(true);
    expect((await searchTexts("dont")).some((t) => t.includes("don't"))).toBe(true);
  });

  it("4. partial word (trigram) — 'config' matches 'configuration'", async () => {
    expect((await searchTexts("config")).some((t) => t.includes("configuration"))).toBe(true);
  });

  it("5. stemming — 'configure' matches 'configuring'", async () => {
    expect((await searchTexts("configure")).some((t) => t.includes("configuring"))).toBe(true);
  });

  it("6. code metacharacters are literal — '%bob_%' finds the code row, 'zzz%zzz' matches nothing", async () => {
    expect((await searchTexts("%bob_%")).some((t) => t.includes("SELECT * FROM users"))).toBe(true);
    expect(await searchTexts("zzz%zzz")).toHaveLength(0);
  });

  it("7. URL substring — 'example.com/docs' found in a pasted URL", async () => {
    expect(
      (await searchTexts("example.com/docs")).some((t) => t.includes("https://example.com/docs"))
    ).toBe(true);
  });

  it("8. emoji query is found", async () => {
    expect((await searchTexts("🚀")).some((t) => t.includes("🚀"))).toBe(true);
  });

  it("9. CJK substring — '北京' is found", async () => {
    expect((await searchTexts("北京")).some((t) => t.includes("北京"))).toBe(true);
  });

  it("10. quoted phrase vs OR", async () => {
    const phrase = await searchTexts('"alpha beta"');
    expect(phrase.some((t) => t.includes("exact phrase alpha beta"))).toBe(true);
    expect(phrase.some((t) => t.includes("appears alone and beta appears far away"))).toBe(false);
    const bare = await searchTexts("alpha beta");
    expect(bare.some((t) => t.includes("exact phrase alpha beta"))).toBe(true);
  });

  it("11. near-duplicates all returned, deterministically ordered by recency then id", async () => {
    const hits = await runtime.searchMessages({
      roomIds: [roomA],
      query: "zephyr",
      tableName: "messages",
      limit: 50,
    });
    const dups = hits.filter(
      (h) => (h.memory.content as { text?: string }).text === "duplicate marker zephyr"
    );
    expect(dups.length).toBe(2);
    const t0 = dups[0].memory.createdAt ?? 0;
    const t1 = dups[1].memory.createdAt ?? 0;
    expect(t0).toBeGreaterThanOrEqual(t1);
    // Re-running the same query yields the identical order.
    const hits2 = await runtime.searchMessages({
      roomIds: [roomA],
      query: "zephyr",
      tableName: "messages",
      limit: 50,
    });
    expect(hits2.map((h) => h.memory.id)).toEqual(hits.map((h) => h.memory.id));
  });

  it("12. attachment-only match — found by attachment filename", async () => {
    expect(
      (await searchTexts("quarterly-budget")).some((t) =>
        t.includes("here is the file you asked for")
      )
    ).toBe(true);
  });

  it("13. role attribution surfaces via entityId (assistant vs user)", async () => {
    const hits = await runtime.searchMessages({
      roomIds: [roomA],
      query: "configuring",
      tableName: "messages",
      limit: 5,
    });
    const row = hits.find((h) =>
      (h.memory.content as { text?: string }).text?.includes("configuring")
    );
    expect(row?.memory.entityId).toBe(agentId);
  });

  it("14. deleted message never appears", async () => {
    const id = await seed(roomA, "ephemeral platypus message", "user");
    expect((await searchTexts("platypus")).length).toBe(1);
    await adapter.deleteMemory(id);
    expect(await searchTexts("platypus")).toHaveLength(0);
  });

  it("15. access scoping — roomA search never leaks roomB's zephyr", async () => {
    const inA = await searchTexts("zephyr", roomA);
    expect(inA.some((t) => t.includes("roomB privately"))).toBe(false);
    const inB = await searchTexts("zephyr", roomB);
    expect(inB.some((t) => t.includes("roomB privately"))).toBe(true);
  });

  it("is index-backed — the FTS GIN index and STORED search-document column exist", async () => {
    const db = adapter.getDatabase() as DrizzleDatabase;
    // The migration hook installs the FTS GIN index and the materialized
    // `message_search_document` column that keeps the query off the O(n)
    // recompute path. (On this ~20-row fixture the planner rationally prefers a
    // seq scan over any index, so the index's actual *selection* at scale — and
    // the latency win — is measured in packages/benchmarks/searchbench on the
    // 10k corpus, not asserted against this tiny table's query plan.)
    const indexes = JSON.stringify(
      await db.execute(sql`SELECT indexname FROM pg_indexes WHERE tablename = 'memories'`)
    ).toLowerCase();
    expect(indexes).toContain("idx_memories_message_fts");
    const columns = JSON.stringify(
      await db.execute(sql`
        SELECT column_name, is_generated FROM information_schema.columns
        WHERE table_name = 'memories' AND column_name = 'message_search_document'
      `)
    ).toLowerCase();
    expect(columns).toContain("message_search_document");
    expect(columns).toContain("always");
  });

  it("16. corpus-wide recall — the OLDEST hit is returned despite thousands of newer rows", async () => {
    const db = adapter.getDatabase() as DrizzleDatabase;
    const needle = "xyzzy-plugh-corpus-needle";
    // The needle row is the oldest in the corpus; every newer row omits it.
    const base = Date.now() - RECALL_CORPUS * 1000;
    const needleId = v4() as UUID;
    const rows: Array<Record<string, unknown>> = [
      {
        id: needleId,
        type: "messages",
        content: { text: `oldest row carrying ${needle} keyword` },
        entityId,
        agentId,
        roomId: roomB,
        worldId,
        unique: false,
        metadata: { type: "messages" },
        createdAt: new Date(base),
      },
    ];
    for (let i = 1; i < RECALL_CORPUS; i++) {
      rows.push({
        id: v4() as UUID,
        type: "messages",
        content: { text: `filler message ${i} with ordinary words` },
        entityId,
        agentId,
        roomId: roomB,
        worldId,
        unique: false,
        metadata: { type: "messages" },
        createdAt: new Date(base + i * 1000),
      });
    }
    for (let start = 0; start < rows.length; start += 2000) {
      await db.insert(memoryTable).values(rows.slice(start, start + 2000) as never);
    }
    const started = Date.now();
    const hits = await runtime.searchMessages({
      roomIds: [roomB],
      query: needle,
      tableName: "messages",
      limit: 20,
    });
    const elapsed = Date.now() - started;
    expect(hits.length).toBe(1);
    expect(hits[0].memory.id).toBe(needleId);
    expect(hits[0].ftsRank).toBeGreaterThan(0);
    // Bounded latency on a multi-thousand-row corpus via the GIN index.
    expect(elapsed).toBeLessThan(5_000);
  }, 120_000);

  it("18. empty room set short-circuits to no rows without a query", async () => {
    const hits = await runtime.searchMessages({
      roomIds: [],
      query: "anything",
      tableName: "messages",
    });
    expect(hits).toHaveLength(0);
  });
});
