/**
 * Drives the shared_agent_memories repository against real in-process PGlite
 * (schema pushed from the Drizzle definition, pgvector extension loaded) so
 * tenant isolation, replay convergence, recency ordering, and genuine cosine
 * ranking are proven on real rows rather than mocked chains.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
  LEGACY_BGE_SMALL_MEAN_EMBEDDING_SPACE_FINGERPRINT,
} from "@elizaos/core/edge";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

import { pushSchema } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../client";
import { organizations } from "../schemas/organizations";
import { sharedAgentMemories } from "../schemas/shared-agent-memories";
import { users } from "../schemas/users";
import { sharedAgentMemoriesReader, sharedAgentMemoriesWriter } from "./shared-agent-memories";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "33333333-3333-4333-8333-333333333333";
const USER_B = "44444444-4444-4444-8444-444444444444";
const AGENT_A = "55555555-5555-4555-8555-555555555555";
const AGENT_B = "66666666-6666-4666-8666-666666666666";
const ROOM_A = "77777777-7777-4777-8777-777777777777";
const ROOM_B = "88888888-8888-4888-8888-888888888888";

const scopeA = { organizationId: ORG_A, userId: USER_A, agentId: AGENT_A };
const scopeB = { organizationId: ORG_B, userId: USER_B, agentId: AGENT_B };

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[shared-agent-memories.integration.test] isolated PGlite is required; refusing to mutate an ambient Postgres database.",
    );
    return;
  }
  try {
    await dbWrite.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
    const { apply } = await pushSchema(
      { organizations, users, sharedAgentMemories } as never,
      dbWrite as never,
    );
    await apply();
    await dbWrite
      .insert(organizations)
      .values([
        { id: ORG_A, name: "Org A", slug: "org-a" },
        { id: ORG_B, name: "Org B", slug: "org-b" },
      ])
      .onConflictDoNothing();
    await dbWrite
      .insert(users)
      .values([
        { id: USER_A, organization_id: ORG_A, steward_user_id: "steward-user-a" },
        { id: USER_B, organization_id: ORG_B, steward_user_id: "steward-user-b" },
      ])
      .onConflictDoNothing();
  } catch (error) {
    pgliteReady = false;
    console.error("[shared-agent-memories.integration.test] PGlite schema setup failed.", error);
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(sharedAgentMemories);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("SharedAgentMemoriesWriter.insertMemory (real PGlite)", () => {
  test("persists a fully scoped core-shape row and replays idempotently", async () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const first = await sharedAgentMemoriesWriter.insertMemory({
      id,
      scope: scopeA,
      entityId: USER_A,
      roomId: ROOM_A,
      type: "messages",
      content: { text: "hello world", source: "shared-runtime", channelType: "DM" },
      embedding: [1, 0, 0],
      embeddingModel: "test-embedder",
    });
    expect(first).toEqual({ id, inserted: true });

    const replay = await sharedAgentMemoriesWriter.insertMemory({
      id,
      scope: scopeA,
      roomId: ROOM_A,
      type: "messages",
      content: { text: "hello world", source: "shared-runtime", channelType: "DM" },
    });
    expect(replay).toEqual({ id, inserted: false });

    const [row] = await sharedAgentMemoriesReader.listRecentByRoom(scopeA, ROOM_A, 10);
    expect(row?.id).toBe(id);
    expect(row?.organization_id).toBe(ORG_A);
    expect(row?.user_id).toBe(USER_A);
    expect(row?.content).toEqual({
      text: "hello world",
      source: "shared-runtime",
      channelType: "DM",
    });
    expect(row?.embedding).toEqual([1, 0, 0]);
    expect(row?.embedding_model).toBe("test-embedder");
  });

  test("rejects reusing another tenant's row id instead of silently no-oping", async () => {
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await sharedAgentMemoriesWriter.insertMemory({
      id,
      scope: scopeA,
      roomId: ROOM_A,
      type: "messages",
      content: { text: "owned by tenant A" },
    });
    await expect(
      sharedAgentMemoriesWriter.insertMemory({
        id,
        scope: scopeB,
        roomId: ROOM_B,
        type: "messages",
        content: { text: "tenant B replay attempt" },
      }),
    ).rejects.toThrow("conflicts outside its tenant");
  });

  test("rejects a row whose organization does not exist (FK enforced)", async () => {
    await expect(
      sharedAgentMemoriesWriter.insertMemory({
        scope: {
          organizationId: "99999999-9999-4999-8999-999999999999",
          userId: USER_A,
          agentId: AGENT_A,
        },
        type: "messages",
        content: { text: "orphan" },
      }),
    ).rejects.toThrow();
  });
});

describe("SharedAgentMemoriesWriter.mergeMessageMemory (real PGlite)", () => {
  const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const message = (text: string, interrupted: boolean) => ({
    id,
    scope: scopeA,
    entityId: AGENT_A,
    roomId: ROOM_A,
    type: "messages",
    content: { text, source: "shared-runtime", channelType: "DM" },
    interrupted,
  });

  test("upgrades an interrupted prefix to the complete retry atomically", async () => {
    const first = await sharedAgentMemoriesWriter.mergeMessageMemory(message("partial", true));
    expect(first).toEqual({ id, inserted: true });

    const retry = await sharedAgentMemoriesWriter.mergeMessageMemory(
      message("complete response", false),
    );
    expect(retry).toEqual({ id, inserted: false });

    const [row] = await sharedAgentMemoriesReader.listRecentByRoom(scopeA, ROOM_A, 10);
    expect(row?.content).toEqual({
      text: "complete response",
      source: "shared-runtime",
      channelType: "DM",
    });
  });

  test("keeps the longest interrupted prefix and lets a later complete retry converge", async () => {
    await sharedAgentMemoriesWriter.mergeMessageMemory(message("part", true));
    await sharedAgentMemoriesWriter.mergeMessageMemory(message("partial response", true));
    await sharedAgentMemoriesWriter.mergeMessageMemory(message("tiny", true));

    let [row] = await sharedAgentMemoriesReader.listRecentByRoom(scopeA, ROOM_A, 10);
    expect(row?.content).toEqual({
      text: "partial response",
      source: "shared-runtime",
      channelType: "DM",
      interrupted: true,
    });

    await sharedAgentMemoriesWriter.mergeMessageMemory(message("complete response", false));
    await sharedAgentMemoriesWriter.mergeMessageMemory(message("late interrupted text", true));
    [row] = await sharedAgentMemoriesReader.listRecentByRoom(scopeA, ROOM_A, 10);
    expect(row?.content).toEqual({
      text: "complete response",
      source: "shared-runtime",
      channelType: "DM",
    });

    await sharedAgentMemoriesWriter.mergeMessageMemory(message("retry terminal response", false));
    [row] = await sharedAgentMemoriesReader.listRecentByRoom(scopeA, ROOM_A, 10);
    expect(row?.content).toEqual({
      text: "retry terminal response",
      source: "shared-runtime",
      channelType: "DM",
    });
  });

  test("clears a stale embedding pair when text changes and atomically accepts a replacement pair", async () => {
    await sharedAgentMemoriesWriter.mergeMessageMemory({
      ...message("partial", true),
      embedding: [1, 0, 0],
      embeddingModel: "partial-space",
    });

    await sharedAgentMemoriesWriter.mergeMessageMemory(message("complete response", false));
    let [row] = await sharedAgentMemoriesReader.listRecentByRoom(scopeA, ROOM_A, 10);
    expect(row?.content.text).toBe("complete response");
    expect(row?.embedding).toBeNull();
    expect(row?.embedding_model).toBeNull();

    await sharedAgentMemoriesWriter.mergeMessageMemory({
      ...message("replacement response", false),
      embedding: [0, 1, 0],
      embeddingModel: "replacement-space",
    });
    [row] = await sharedAgentMemoriesReader.listRecentByRoom(scopeA, ROOM_A, 10);
    expect(row?.content.text).toBe("replacement response");
    expect(row?.embedding).toEqual([0, 1, 0]);
    expect(row?.embedding_model).toBe("replacement-space");
  });

  test("retains an embedding pair when only interrupted metadata changes", async () => {
    await sharedAgentMemoriesWriter.mergeMessageMemory({
      ...message("same response text", true),
      embedding: [1, 0, 0],
      embeddingModel: "same-text-space",
    });
    await sharedAgentMemoriesWriter.mergeMessageMemory(message("same response text", false));

    const [row] = await sharedAgentMemoriesReader.listRecentByRoom(scopeA, ROOM_A, 10);
    expect(row?.content).toEqual({
      text: "same response text",
      source: "shared-runtime",
      channelType: "DM",
    });
    expect(row?.embedding).toEqual([1, 0, 0]);
    expect(row?.embedding_model).toBe("same-text-space");
  });

  test("rejects half-supplied embedding metadata before writing", async () => {
    await expect(
      sharedAgentMemoriesWriter.mergeMessageMemory({
        ...message("missing model", false),
        embedding: [1, 0, 0],
      }),
    ).rejects.toThrow("must be supplied together");
    await expect(
      sharedAgentMemoriesWriter.mergeMessageMemory({
        ...message("missing vector", false),
        embeddingModel: "orphan-model",
      }),
    ).rejects.toThrow("must be supplied together");
  });

  test("rejects a colliding id outside the tenant on the merge path", async () => {
    await sharedAgentMemoriesWriter.mergeMessageMemory(message("tenant A", true));
    await expect(
      sharedAgentMemoriesWriter.mergeMessageMemory({
        ...message("tenant B", false),
        scope: scopeB,
        roomId: ROOM_B,
      }),
    ).rejects.toThrow("conflicts outside its tenant");
  });
});

describe("SharedAgentMemoriesReader.listRecentByRoom (real PGlite)", () => {
  test("returns only the scoped tenant's room rows, newest first, capped", async () => {
    const base = Date.now() - 60_000;
    for (let index = 0; index < 4; index += 1) {
      await sharedAgentMemoriesWriter.insertMemory({
        scope: scopeA,
        roomId: ROOM_A,
        type: "messages",
        content: { text: `tenant A turn ${index}` },
        createdAt: new Date(base + index * 1000),
      });
    }
    await sharedAgentMemoriesWriter.insertMemory({
      scope: scopeA,
      roomId: ROOM_B,
      type: "messages",
      content: { text: "tenant A, other room" },
      createdAt: new Date(base + 10_000),
    });
    await sharedAgentMemoriesWriter.insertMemory({
      scope: scopeB,
      roomId: ROOM_A,
      type: "messages",
      content: { text: "tenant B, same room id" },
      createdAt: new Date(base + 20_000),
    });

    const rows = await sharedAgentMemoriesReader.listRecentByRoom(scopeA, ROOM_A, 3);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.content.text)).toEqual([
      "tenant A turn 3",
      "tenant A turn 2",
      "tenant A turn 1",
    ]);
    expect(rows.every((row) => row.organization_id === ORG_A && row.user_id === USER_A)).toBe(true);
  });
});

describe("SharedAgentMemoriesReader.searchByEmbedding (real PGlite + pgvector)", () => {
  test("ranks only the tenant's exact vector space and excludes same-width legacy models", async () => {
    const fingerprint = CANONICAL_EMBEDDING_SPACE_FINGERPRINT;
    await sharedAgentMemoriesWriter.insertMemory({
      scope: scopeA,
      roomId: ROOM_A,
      type: "messages",
      content: { text: "exact match" },
      embedding: [1, 0, 0],
      embeddingModel: fingerprint,
    });
    await sharedAgentMemoriesWriter.insertMemory({
      scope: scopeA,
      roomId: ROOM_A,
      type: "messages",
      content: { text: "near match" },
      embedding: [0.9, 0.1, 0],
      embeddingModel: fingerprint,
    });
    await sharedAgentMemoriesWriter.insertMemory({
      scope: scopeA,
      roomId: ROOM_A,
      type: "messages",
      content: { text: "orthogonal" },
      embedding: [0, 1, 0],
      embeddingModel: fingerprint,
    });
    // Dimension mismatch: must be filtered out, not fail the whole query.
    await sharedAgentMemoriesWriter.insertMemory({
      scope: scopeA,
      roomId: ROOM_A,
      type: "messages",
      content: { text: "other model dims" },
      embedding: [1, 0],
      embeddingModel: fingerprint,
    });
    // Same width and tenant, but an incompatible legacy vector space.
    await sharedAgentMemoriesWriter.insertMemory({
      scope: scopeA,
      roomId: ROOM_A,
      type: "messages",
      content: { text: "legacy GTE exact match" },
      embedding: [1, 0, 0],
      embeddingModel: "thenlper/gte-small:384:mean:l2:v1",
    });
    await sharedAgentMemoriesWriter.insertMemory({
      scope: scopeA,
      roomId: ROOM_A,
      type: "messages",
      content: { text: "legacy BGE mean exact match" },
      embedding: [1, 0, 0],
      embeddingModel: LEGACY_BGE_SMALL_MEAN_EMBEDDING_SPACE_FINGERPRINT,
    });
    // Same vector in tenant B: a leak would rank first.
    await sharedAgentMemoriesWriter.insertMemory({
      scope: scopeB,
      roomId: ROOM_A,
      type: "messages",
      content: { text: "tenant B exact match" },
      embedding: [1, 0, 0],
      embeddingModel: fingerprint,
    });

    const hits = await sharedAgentMemoriesReader.searchByEmbedding(
      scopeA,
      [1, 0, 0],
      5,
      fingerprint,
    );
    expect(hits.map((hit) => hit.content.text)).toEqual([
      "exact match",
      "near match",
      "orthogonal",
    ]);
    expect(hits[0]?.distance).toBeCloseTo(0, 5);
    expect(hits[1]?.distance).toBeGreaterThan(0);
    expect(hits[2]?.distance).toBeCloseTo(1, 5);
    expect(hits.every((hit) => hit.organization_id === ORG_A)).toBe(true);
  });

  test("returns an explicit empty result when the tenant has no embedded rows", async () => {
    await sharedAgentMemoriesWriter.insertMemory({
      scope: scopeA,
      roomId: ROOM_A,
      type: "messages",
      content: { text: "no embedding stored" },
    });
    const hits = await sharedAgentMemoriesReader.searchByEmbedding(scopeA, [1, 0, 0], 5);
    expect(hits).toEqual([]);
  });
});

describe("SharedAgentMemoriesReader.listEmbeddingBackfillCandidates (real PGlite)", () => {
  test("returns only tenant-owned incompatible vectors, oldest first and bounded", async () => {
    const rows = [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
        scope: scopeA,
        content: { text: "old mean" },
        embeddingModel: LEGACY_BGE_SMALL_MEAN_EMBEDDING_SPACE_FINGERPRINT,
        createdAt: new Date("2026-08-01T00:00:00Z"),
      },
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000002",
        scope: scopeA,
        content: { text: "old GTE" },
        embeddingModel: "thenlper/gte-small:384:mean:l2:v1",
        createdAt: new Date("2026-08-02T00:00:00Z"),
      },
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000003",
        scope: scopeA,
        content: { text: "already CLS" },
        embeddingModel: CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
        createdAt: new Date("2026-08-03T00:00:00Z"),
      },
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000004",
        scope: scopeB,
        content: { text: "other tenant mean" },
        embeddingModel: LEGACY_BGE_SMALL_MEAN_EMBEDDING_SPACE_FINGERPRINT,
        createdAt: new Date("2026-07-01T00:00:00Z"),
      },
    ] as const;
    for (const row of rows) {
      await sharedAgentMemoriesWriter.insertMemory({
        id: row.id,
        scope: row.scope,
        type: "messages",
        content: row.content,
        embedding: [1, 0, 0],
        embeddingModel: row.embeddingModel,
        createdAt: row.createdAt,
      });
    }

    await expect(
      sharedAgentMemoriesReader.listEmbeddingBackfillCandidates(
        scopeA,
        CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
        1,
      ),
    ).resolves.toEqual([{ id: rows[0].id, contentText: "old mean" }]);
    await expect(
      sharedAgentMemoriesReader.listEmbeddingBackfillCandidates(
        scopeA,
        CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
        16,
      ),
    ).resolves.toEqual([
      { id: rows[0].id, contentText: "old mean" },
      { id: rows[1].id, contentText: "old GTE" },
    ]);
  });
});
