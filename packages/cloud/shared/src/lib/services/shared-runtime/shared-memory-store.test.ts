/**
 * Deterministic tests for the flag-gated SharedMemoryStore: env gating, the
 * runtime-identical storage identities stamped on each row, transport-id
 * reuse for replay-idempotent writes, and fail-fast propagation. The writer
 * is a scripted in-memory double; real SQL behavior is covered by the
 * repository's own unit and integration suites.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { stringToUuid } from "@elizaos/core/edge";
import type {
  InsertSharedAgentMemoryInput,
  MergeSharedAgentMessageMemoryInput,
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
} {
  const inserts: InsertSharedAgentMemoryInput[] = [];
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
  } as SharedAgentMemoriesWriter;
  return { writer, inserts };
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
      source: "telegram",
      channelType: "VOICE_DM",
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
      source: "telegram",
      channelType: "VOICE_DM",
    });
    expect(assistantRow?.id).toBe(messageIds.assistant);
    expect(assistantRow?.entityId).toBe(storage.agentId);
    expect(assistantRow?.content).toEqual({
      text: "noted — the launch is on Friday",
      source: "telegram",
      channelType: "VOICE_DM",
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
