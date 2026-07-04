/**
 * Focused correctness test for the keyword (`textContains`) predicate on the
 * SQL `getMemories` path — the small, fast complement to the 200k-row
 * `memory-keyword-search.real.test.ts` scale test.
 *
 * It pins the load-bearing details the scale test cannot exercise cheaply:
 * literal `_` and backslash escaping (not just `%`), AND-composition with the
 * existing `roomId` / `tableName` filters, and that the predicate targets
 * `content->>'text'` ONLY (a token hidden in another `content` field or in
 * `metadata` must NOT match). Runs on PGlite by default; set `POSTGRES_URL`
 * to run against a real Postgres.
 */
import {
  ChannelType,
  type Content,
  type Entity,
  type Memory,
  type MemoryMetadata,
  MemoryType,
  type Room,
  type UUID,
  type World,
} from "@elizaos/core";
import { v4 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { embeddingTable, memoryTable } from "../../schema";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("getMemories textContains keyword filter (real SQL adapter)", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let roomA: UUID;
  let roomB: UUID;
  let entityId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("memory_text_contains");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    const worldId = v4() as UUID;
    await adapter.createWorld({
      id: worldId,
      agentId: testAgentId,
      name: "TextContains World",
      serverId: "text-contains-server",
    } as World);

    roomA = v4() as UUID;
    roomB = v4() as UUID;
    await adapter.createRooms([
      {
        id: roomA,
        agentId: testAgentId,
        worldId,
        name: "room-a",
        source: "test",
        type: ChannelType.DM,
      } as Room,
      {
        id: roomB,
        agentId: testAgentId,
        worldId,
        name: "room-b",
        source: "test",
        type: ChannelType.DM,
      } as Room,
    ]);

    entityId = v4() as UUID;
    await adapter.createEntities([
      { id: entityId, agentId: testAgentId, names: ["Text Entity"] } as Entity,
    ]);
    await adapter.addParticipant(entityId, roomA);
    await adapter.addParticipant(entityId, roomB);
  });

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    const db = adapter.getDatabase() as DrizzleDatabase;
    await db.delete(embeddingTable);
    await db.delete(memoryTable);
  });

  /** Seed one row (defaults to the `messages` table in `roomA`). */
  const seed = async (
    content: Content,
    options: { roomId?: UUID; tableName?: string } = {}
  ): Promise<void> => {
    const memory: Memory & { metadata: MemoryMetadata } = {
      id: v4() as UUID,
      agentId: testAgentId,
      roomId: options.roomId ?? roomA,
      entityId,
      content,
      createdAt: Date.now(),
      unique: false,
      metadata: { type: MemoryType.MESSAGE, source: "test" },
    };
    await adapter.createMemory(memory, options.tableName ?? "messages");
  };

  const textsFor = async (
    textContains: string,
    options: { roomId?: UUID; tableName?: string } = {}
  ): Promise<string[]> => {
    const rows = await adapter.getMemories({
      tableName: options.tableName ?? "messages",
      roomId: options.roomId ?? roomA,
      textContains,
      includeEmbedding: false,
    });
    return rows
      .map((row) => row.content.text)
      .filter((text): text is string => typeof text === "string");
  };

  it("matches case-insensitively (ILIKE, not LIKE)", async () => {
    await seed({ text: "Hello World" });
    await seed({ text: "goodbye" });

    for (const needle of ["hello", "HELLO", "HeLLo"]) {
      const texts = await textsFor(needle);
      expect(texts).toEqual(["Hello World"]);
    }
  });

  it("matches an arbitrary substring, not just a prefix or whole word", async () => {
    await seed({ text: "the quick brown fox" });

    expect(await textsFor("quick")).toEqual(["the quick brown fox"]);
    expect(await textsFor("own fo")).toEqual(["the quick brown fox"]);
    expect(await textsFor("brown fox")).toEqual(["the quick brown fox"]);
  });

  it("returns nothing when no row contains the keyword", async () => {
    await seed({ text: "alpha" });
    await seed({ text: "beta" });

    expect(await textsFor("gamma")).toEqual([]);
  });

  it("escapes a literal `%` so it is not a wildcard", async () => {
    await seed({ text: "50% off sale" });
    await seed({ text: "50 percent off" });

    // Unescaped, `%50%%` would also match "50 percent off".
    expect(await textsFor("50%")).toEqual(["50% off sale"]);
  });

  it("escapes a literal `_` so it is not a single-char wildcard", async () => {
    await seed({ text: "user_name field" });
    await seed({ text: "username field" });
    await seed({ text: "userXname field" });

    // Unescaped, `_` would match the X and the absent char too.
    expect(await textsFor("user_name")).toEqual(["user_name field"]);
  });

  it("escapes a literal backslash so the ESCAPE char does not corrupt the pattern", async () => {
    await seed({ text: "path\\to\\file" });
    await seed({ text: "pathtofile" });

    expect(await textsFor("path\\to")).toEqual(["path\\to\\file"]);
  });

  it("treats an empty / whitespace query as a no-op filter", async () => {
    await seed({ text: "one" });
    await seed({ text: "two" });
    await seed({ text: "three" });

    expect((await textsFor("")).sort()).toEqual(["one", "three", "two"]);
    expect((await textsFor("   ")).sort()).toEqual(["one", "three", "two"]);
  });

  it("AND-combines with the roomId filter (scoped, not OR)", async () => {
    await seed({ text: "find me here" }, { roomId: roomA });
    await seed({ text: "find me there" }, { roomId: roomB });

    expect(await textsFor("find", { roomId: roomA })).toEqual(["find me here"]);
    expect(await textsFor("find", { roomId: roomB })).toEqual(["find me there"]);
  });

  it("AND-combines with the tableName (type) filter", async () => {
    await seed({ text: "find me in messages" }, { tableName: "messages" });
    await seed({ text: "find me in memories" }, { tableName: "memories" });

    expect(await textsFor("find", { tableName: "messages" })).toEqual(["find me in messages"]);
    expect(await textsFor("find", { tableName: "memories" })).toEqual(["find me in memories"]);
  });

  it("matches `content->>'text'` ONLY — not other content fields or metadata", async () => {
    // The needle lives in `content.thought` / `content.source`, never in
    // `content.text`. A whole-jsonb `content::text ILIKE` would wrongly match;
    // the `->>'text'` extraction must not.
    await seed({
      text: "totally ordinary message body",
      thought: "zzqhiddenxx internal reasoning",
      source: "zzqhiddenxx",
    });
    // A control row whose text DOES carry the needle, so a positive match exists.
    await seed({ text: "this line mentions zzqhiddenxx directly" });

    expect(await textsFor("zzqhiddenxx")).toEqual(["this line mentions zzqhiddenxx directly"]);
  });
});
