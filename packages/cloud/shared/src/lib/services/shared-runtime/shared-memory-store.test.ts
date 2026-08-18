/**
 * Deterministic tests for the flag-gated SharedMemoryStore: env gating, the
 * runtime-identical storage identities stamped on each row, transport-id
 * reuse for replay-idempotent writes, and fail-fast propagation. The writer
 * is a scripted in-memory double; real SQL behavior is covered by the
 * repository's own unit and integration suites.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
  LEGACY_BGE_SMALL_MEAN_EMBEDDING_SPACE_FINGERPRINT,
  stringToUuid,
} from "@elizaos/core/edge";
import type {
  InsertSharedAgentMemoryInput,
  MergeSharedAgentMessageMemoryInput,
  SetSharedAgentMemoryEmbeddingInput,
  SharedAgentMemoriesReader,
  SharedAgentMemoriesWriter,
} from "../../../db/repositories/shared-agent-memories";
import {
  createSharedMemoryStore,
  SharedMemoryStore,
  sharedMemoryTablesEnabled,
} from "./shared-memory-store";
import {
  sharedRuntimeConversationRoomId,
  sharedRuntimeWorldId,
  sharedTodoStorageScope,
} from "./shared-runtime-storage-identity";

const ORG = "5a5c62c4-51b6-4e94-8c4e-a41d62b85e2f";
const USER = "9a3d9f2e-97ab-46be-a687-3a4f2f6bfa53";
const AGENT_KEY = "agent-shared-42";

function scriptedWriter(behavior?: { failOn?: number }): {
  writer: SharedAgentMemoriesWriter;
  inserts: InsertSharedAgentMemoryInput[];
  embeddingUpdates: SetSharedAgentMemoryEmbeddingInput[];
} {
  const inserts: InsertSharedAgentMemoryInput[] = [];
  const embeddingUpdates: SetSharedAgentMemoryEmbeddingInput[] = [];
  const write = async (input: InsertSharedAgentMemoryInput) => {
    inserts.push(input);
    if (behavior?.failOn === inserts.length) {
      throw new Error("scripted storage failure");
    }
    return { id: input.id ?? "generated-id", inserted: true };
  };
  const writer = {
    insertMemory: write,
    async mergeMessageMemory(input: MergeSharedAgentMessageMemoryInput) {
      const { interrupted, ...memory } = input;
      return await write({
        ...memory,
        content: {
          ...memory.content,
          ...(interrupted ? { interrupted: true } : {}),
        },
      });
    },
    async setMemoryEmbedding(input: SetSharedAgentMemoryEmbeddingInput) {
      embeddingUpdates.push(input);
      return true;
    },
  } as SharedAgentMemoriesWriter;
  return { writer, inserts, embeddingUpdates };
}

const originalFlag = process.env.SHARED_MEMORY_TABLES_ENABLED;

afterEach(() => {
  if (originalFlag === undefined) delete process.env.SHARED_MEMORY_TABLES_ENABLED;
  else process.env.SHARED_MEMORY_TABLES_ENABLED = originalFlag;
});

describe("sharedMemoryTablesEnabled / createSharedMemoryStore", () => {
  test("only the literal string 'true' enables the store", () => {
    expect(sharedMemoryTablesEnabled(undefined)).toBe(false);
    expect(sharedMemoryTablesEnabled("")).toBe(false);
    expect(sharedMemoryTablesEnabled("1")).toBe(false);
    expect(sharedMemoryTablesEnabled("TRUE")).toBe(false);
    expect(sharedMemoryTablesEnabled("true")).toBe(true);

    process.env.SHARED_MEMORY_TABLES_ENABLED = "false";
    expect(
      createSharedMemoryStore({ organizationId: ORG, userId: USER, agentKey: AGENT_KEY }),
    ).toBeNull();
    process.env.SHARED_MEMORY_TABLES_ENABLED = "true";
    expect(
      createSharedMemoryStore({ organizationId: ORG, userId: USER, agentKey: AGENT_KEY }),
    ).toBeInstanceOf(SharedMemoryStore);
  });
});

describe("SharedMemoryStore.recordTurnPair", () => {
  test("lands rows before deferred Workers AI enrichment settles", async () => {
    const fingerprint = CANONICAL_EMBEDDING_SPACE_FINGERPRINT;
    const { writer, inserts, embeddingUpdates } = scriptedWriter();
    let releaseEmbeddings!: (vectors: number[][]) => void;
    const embeddingGate = new Promise<number[][]>((resolve) => {
      releaseEmbeddings = resolve;
    });
    const scheduled: Promise<void>[] = [];
    const store = new SharedMemoryStore(
      { organizationId: ORG, userId: USER, agentKey: AGENT_KEY },
      writer,
      {
        async listEmbeddingBackfillCandidates() {
          return [];
        },
      } as unknown as SharedAgentMemoriesReader,
      { embedTexts: async () => embeddingGate, model: fingerprint },
      (work) => scheduled.push(work),
    );

    await store.recordTurnPair({
      userMessage: "remember this",
      assistantReply: "remembered",
      messageIds: {
        user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        assistant: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
    });

    expect(inserts).toHaveLength(2);
    expect(inserts.every((row) => row.embedding === undefined)).toBe(true);
    expect(embeddingUpdates).toHaveLength(0);
    expect(scheduled).toHaveLength(1);

    const userVector = new Array(384).fill(0);
    userVector[0] = 1;
    const assistantVector = new Array(384).fill(0);
    assistantVector[1] = 1;
    releaseEmbeddings([userVector, assistantVector]);
    await Promise.all(scheduled);

    expect(embeddingUpdates).toEqual([
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        scope: {
          organizationId: ORG,
          userId: USER,
          agentId: stringToUuid(AGENT_KEY),
        },
        contentText: "remember this",
        embedding: userVector,
        embeddingModel: fingerprint,
      },
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        scope: {
          organizationId: ORG,
          userId: USER,
          agentId: stringToUuid(AGENT_KEY),
        },
        contentText: "remembered",
        embedding: assistantVector,
        embeddingModel: fingerprint,
      },
    ]);
  });

  test("persists and searches with one exact vector-space fingerprint", async () => {
    const fingerprint = CANONICAL_EMBEDDING_SPACE_FINGERPRINT;
    const { writer, inserts } = scriptedWriter();
    const searchCalls: unknown[][] = [];
    const reader = {
      async searchByEmbedding(...args: unknown[]) {
        searchCalls.push(args);
        return [];
      },
      async listEmbeddingBackfillCandidates() {
        return [];
      },
    } as unknown as SharedAgentMemoriesReader;
    const vectors = [
      new Array(384).fill(0).map((_, index) => (index === 0 ? 1 : 0)),
      new Array(384).fill(0).map((_, index) => (index === 1 ? 1 : 0)),
    ];
    const store = new SharedMemoryStore(
      { organizationId: ORG, userId: USER, agentKey: AGENT_KEY },
      writer,
      reader,
      {
        embedTexts: async () => vectors,
        model: fingerprint,
      },
    );

    await store.recordTurnPair({ userMessage: "remember this", assistantReply: "remembered" });
    await store.searchByEmbedding(vectors[0] ?? [], 5);

    expect(inserts[0]?.embedding).toBe(vectors[0]);
    expect(inserts[1]?.embedding).toBe(vectors[1]);
    expect(inserts[0]?.embeddingModel).toBe(fingerprint);
    expect(inserts[1]?.embeddingModel).toBe(fingerprint);
    expect(searchCalls[0]?.[3]).toBe(fingerprint);
  });

  test("re-embeds a bounded legacy batch after live rows without delaying recordTurnPair", async () => {
    const { writer, embeddingUpdates } = scriptedWriter();
    const backfillCalls: unknown[][] = [];
    const candidates = [
      { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", contentText: "legacy mean row" },
      { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", contentText: "legacy GTE row" },
    ];
    const reader = {
      async listEmbeddingBackfillCandidates(...args: unknown[]) {
        backfillCalls.push(args);
        return candidates;
      },
    } as unknown as SharedAgentMemoriesReader;
    let releaseLive!: (vectors: number[][]) => void;
    const liveGate = new Promise<number[][]>((resolve) => {
      releaseLive = resolve;
    });
    const legacyVectors = candidates.map((_, index) => {
      const vector = new Array(384).fill(0);
      vector[index] = 1;
      return vector;
    });
    const liveVectors = [new Array(384).fill(0), new Array(384).fill(0)];
    liveVectors[0][2] = 1;
    liveVectors[1][3] = 1;
    const embedCalls: string[][] = [];
    const scheduled: Promise<void>[] = [];
    const store = new SharedMemoryStore(
      { organizationId: ORG, userId: USER, agentKey: AGENT_KEY },
      writer,
      reader,
      {
        model: CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
        async embedTexts(texts) {
          embedCalls.push(texts);
          return embedCalls.length === 1 ? liveGate : legacyVectors;
        },
      },
      (work) => scheduled.push(work),
    );

    await store.recordTurnPair({
      userMessage: "current user row",
      assistantReply: "current assistant row",
    });

    expect(scheduled).toHaveLength(1);
    expect(embeddingUpdates).toHaveLength(0);
    expect(backfillCalls).toHaveLength(0);

    releaseLive(liveVectors);
    await Promise.all(scheduled);

    expect(embedCalls).toEqual([
      ["current user row", "current assistant row"],
      ["legacy mean row", "legacy GTE row"],
    ]);
    expect(backfillCalls[0]?.[1]).toBe(CANONICAL_EMBEDDING_SPACE_FINGERPRINT);
    expect(backfillCalls[0]?.[2]).toBe(16);
    expect(embeddingUpdates.slice(-2)).toEqual(
      candidates.map((candidate, index) => ({
        id: candidate.id,
        scope: {
          organizationId: ORG,
          userId: USER,
          agentId: stringToUuid(AGENT_KEY),
        },
        contentText: candidate.contentText,
        embedding: legacyVectors[index],
        embeddingModel: CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
      })),
    );
    expect(CANONICAL_EMBEDDING_SPACE_FINGERPRINT).not.toBe(
      LEGACY_BGE_SMALL_MEAN_EMBEDDING_SPACE_FINGERPRINT,
    );
  });

  test("retries the same durable legacy candidate on a later turn after backfill failure", async () => {
    const { writer, embeddingUpdates } = scriptedWriter();
    const candidate = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      contentText: "survives a worker crash",
    };
    let candidateReads = 0;
    const reader = {
      async listEmbeddingBackfillCandidates() {
        candidateReads += 1;
        return [candidate];
      },
    } as unknown as SharedAgentMemoriesReader;
    let embedCall = 0;
    const vector = new Array(384).fill(0);
    vector[0] = 1;
    const scheduled: Promise<void>[] = [];
    const store = new SharedMemoryStore(
      { organizationId: ORG, userId: USER, agentKey: AGENT_KEY },
      writer,
      reader,
      {
        model: CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
        async embedTexts(texts) {
          embedCall += 1;
          if (texts[0] === candidate.contentText && embedCall === 2) {
            throw new Error("worker terminated during legacy batch");
          }
          return texts.map(() => vector);
        },
      },
      (work) => scheduled.push(work),
    );

    await store.recordTurnPair({
      userMessage: "turn one",
      assistantReply: "reply one",
      messageIds: {
        user: "11111111-1111-4111-8111-111111111111",
        assistant: "22222222-2222-4222-8222-222222222222",
      },
    });
    await Promise.all(scheduled.splice(0));
    expect(candidateReads).toBe(1);
    expect(embeddingUpdates.some((update) => update.id === candidate.id)).toBe(false);

    await store.recordTurnPair({
      userMessage: "turn two",
      assistantReply: "reply two",
      messageIds: {
        user: "33333333-3333-4333-8333-333333333333",
        assistant: "44444444-4444-4444-8444-444444444444",
      },
    });
    await Promise.all(scheduled);

    expect(candidateReads).toBe(2);
    expect(embeddingUpdates.find((update) => update.id === candidate.id)).toEqual({
      id: candidate.id,
      scope: {
        organizationId: ORG,
        userId: USER,
        agentId: stringToUuid(AGENT_KEY),
      },
      contentText: candidate.contentText,
      embedding: vector,
      embeddingModel: CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
    });
  });

  test("drains more than one legacy batch in one bounded post-response job", async () => {
    const { writer, embeddingUpdates } = scriptedWriter();
    const candidates = Array.from({ length: 18 }, (_, index) => ({
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, "0")}`,
      contentText: `legacy row ${index + 1}`,
    }));
    let candidateRead = 0;
    const reader = {
      async listEmbeddingBackfillCandidates() {
        candidateRead += 1;
        return candidateRead === 1 ? candidates.slice(0, 16) : candidates.slice(16);
      },
    } as unknown as SharedAgentMemoriesReader;
    const vector = new Array(384).fill(0);
    vector[0] = 1;
    const embedCalls: string[][] = [];
    const scheduled: Promise<void>[] = [];
    const store = new SharedMemoryStore(
      { organizationId: ORG, userId: USER, agentKey: AGENT_KEY },
      writer,
      reader,
      {
        model: CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
        async embedTexts(texts) {
          embedCalls.push(texts);
          return texts.map(() => vector);
        },
      },
      (work) => scheduled.push(work),
    );

    await store.recordTurnPair({ userMessage: "live", assistantReply: "reply" });
    expect(scheduled).toHaveLength(1);
    await Promise.all(scheduled);

    expect(candidateRead).toBe(2);
    expect(embedCalls.map((texts) => texts.length)).toEqual([2, 16, 2]);
    expect(
      embeddingUpdates.filter((update) => candidates.some((row) => row.id === update.id)),
    ).toHaveLength(18);
  });

  test("writes the pair with the runtime's storage identities and transport ids", async () => {
    const { writer, inserts } = scriptedWriter();
    const storage = sharedTodoStorageScope({ sourceAgentId: AGENT_KEY, ownerId: USER });
    const store = new SharedMemoryStore(
      { organizationId: ORG, userId: USER, agentKey: AGENT_KEY, storage },
      writer,
    );
    const messageIds = {
      user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      assistant: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    await store.recordTurnPair({
      userMessage: "remember the launch date",
      assistantReply: "noted — the launch is on Friday",
      messageIds,
    });

    expect(inserts).toHaveLength(2);
    const [userRow, assistantRow] = inserts;
    for (const row of [userRow, assistantRow]) {
      expect(row?.scope).toEqual({
        organizationId: ORG,
        userId: USER,
        agentId: storage.agentId,
      });
      expect(row?.roomId).toBe(sharedRuntimeConversationRoomId(AGENT_KEY));
      expect(row?.worldId).toBe(sharedRuntimeWorldId(AGENT_KEY));
      expect(row?.type).toBe("messages");
    }
    expect(userRow?.id).toBe(messageIds.user);
    expect(userRow?.entityId).toBe(storage.entityId);
    expect(userRow?.content).toEqual({
      text: "remember the launch date",
      source: "shared-runtime",
      channelType: "DM",
    });
    expect(assistantRow?.id).toBe(messageIds.assistant);
    expect(assistantRow?.entityId).toBe(storage.agentId);
    expect(assistantRow?.content).toEqual({
      text: "noted — the launch is on Friday",
      source: "shared-runtime",
      channelType: "DM",
    });
    expect(userRow?.createdAt).toBeInstanceOf(Date);
    expect(assistantRow?.createdAt?.getTime()).toBe((userRow?.createdAt?.getTime() ?? 0) + 1);
  });

  test("derives deterministic fallback identities without a Todo storage scope", async () => {
    const { writer, inserts } = scriptedWriter();
    const store = new SharedMemoryStore(
      { organizationId: ORG, userId: USER, agentKey: AGENT_KEY },
      writer,
    );
    await store.recordTurnPair({
      userMessage: "hello",
      assistantReply: "hi there",
      messageIds: { user: "not-a-uuid-transport-id", assistant: "another-transport-id" },
      messageRole: "system",
    });
    const [userRow, assistantRow] = inserts;
    expect(userRow?.scope.agentId).toBe(stringToUuid(AGENT_KEY));
    expect(userRow?.entityId).toBe(stringToUuid(`${AGENT_KEY}:owner`));
    expect(userRow?.id).toBe(stringToUuid("not-a-uuid-transport-id"));
    expect(userRow?.content?.role).toBe("system");
    expect(assistantRow?.id).toBe(stringToUuid("another-transport-id"));
    expect(assistantRow?.content?.role).toBeUndefined();
  });

  test("mirrors interrupted history and omits an unseen empty assistant row", async () => {
    const interrupted = scriptedWriter();
    const store = new SharedMemoryStore(
      { organizationId: ORG, userId: USER, agentKey: AGENT_KEY },
      interrupted.writer,
    );
    await store.recordTurnPair({
      userMessage: "tell me slowly",
      assistantReply: "partial answer",
      interrupted: true,
    });
    expect(interrupted.inserts[1]?.content).toEqual({
      text: "partial answer",
      source: "shared-runtime",
      channelType: "DM",
      interrupted: true,
    });

    const empty = scriptedWriter();
    const emptyStore = new SharedMemoryStore(
      { organizationId: ORG, userId: USER, agentKey: AGENT_KEY },
      empty.writer,
    );
    await emptyStore.recordTurnPair({
      userMessage: "cancelled before output",
      assistantReply: "   ",
      interrupted: true,
    });
    expect(empty.inserts).toHaveLength(1);
    expect(empty.inserts[0]?.content.text).toBe("cancelled before output");
  });

  test("omits row ids without transport ids and propagates storage failures", async () => {
    const unkeyed = scriptedWriter();
    const store = new SharedMemoryStore(
      { organizationId: ORG, userId: USER, agentKey: AGENT_KEY },
      unkeyed.writer,
    );
    await store.recordTurnPair({ userMessage: "no ids", assistantReply: "still lands" });
    expect(unkeyed.inserts[0]?.id).toBeUndefined();
    expect(unkeyed.inserts[1]?.id).toBeUndefined();

    const failing = scriptedWriter({ failOn: 2 });
    const failingStore = new SharedMemoryStore(
      { organizationId: ORG, userId: USER, agentKey: AGENT_KEY },
      failing.writer,
    );
    await expect(
      failingStore.recordTurnPair({ userMessage: "user landed", assistantReply: "lost" }),
    ).rejects.toThrow("scripted storage failure");
    // Sequential writes: the user row landed before the failure surfaced.
    expect(failing.inserts).toHaveLength(2);
  });
});
