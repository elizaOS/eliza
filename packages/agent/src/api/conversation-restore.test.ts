/**
 * Unit coverage for `conversation-restore.ts` — deterministic world-id
 * derivation and the in-memory conversation rebuild from persisted rooms.
 * Drives the real module against a stub runtime that only supplies
 * `getRoomsByWorld` / `getMemories`; metadata sanitization is the real
 * `extractConversationMetadataFromRoom` path.
 */
import {
  type AgentRuntime,
  type Memory,
  type Room,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ConversationRestoreTarget,
  restoreConversationsFromDb,
  WEB_CONVERSATION_CHANNEL_PREFIX,
  webChatWorldId,
} from "./conversation-restore.ts";
import type { ConversationMeta } from "./server-types.ts";

const FROZEN_ISO = "2026-04-01T15:30:00.000Z";
const FROZEN_MS = Date.parse(FROZEN_ISO);

afterEach(() => {
  vi.useRealTimers();
});

function roomId(label: string): UUID {
  return stringToUuid(`restore-room-${label}`);
}

function webRoom(opts: {
  label: string;
  convId?: string;
  channelId?: string | number | null;
  name?: string;
  metadata?: Room["metadata"];
}): Room {
  const id = roomId(opts.label);
  const channelId =
    opts.channelId !== undefined
      ? opts.channelId
      : `${WEB_CONVERSATION_CHANNEL_PREFIX}${opts.convId ?? opts.label}`;
  return {
    id,
    name: opts.name,
    source: "web",
    type: "DM",
    channelId,
    metadata: opts.metadata,
  } as Room;
}

interface RestoreRuntimeOptions {
  agentName?: string | null;
  rooms?: Room[];
  memoriesByRoom?: Map<string, Array<Pick<Memory, "createdAt">>>;
  worldIds?: UUID[];
  memoryQueries?: Array<{
    roomId: UUID;
    tableName: string;
    limit: number;
  }>;
}

function makeRuntime(opts: RestoreRuntimeOptions = {}): AgentRuntime {
  const rooms = opts.rooms ?? [];
  const memoriesByRoom = opts.memoriesByRoom ?? new Map();
  return {
    character: { name: opts.agentName ?? undefined },
    getRoomsByWorld: async (worldId: UUID) => {
      opts.worldIds?.push(worldId);
      return rooms;
    },
    getMemories: async (query: {
      roomId: UUID;
      tableName: string;
      limit: number;
    }) => {
      opts.memoryQueries?.push({
        roomId: query.roomId,
        tableName: query.tableName,
        limit: query.limit,
      });
      return (memoriesByRoom.get(query.roomId) ?? []) as Memory[];
    },
  } as unknown as AgentRuntime;
}

function emptyTarget(
  extra: Partial<ConversationRestoreTarget> = {},
): ConversationRestoreTarget {
  return {
    conversations: new Map<string, ConversationMeta>(),
    deletedConversationIds: new Set<string>(),
    ...extra,
  };
}

describe("webChatWorldId", () => {
  it("is a deterministic UUID derived from `{agentName}-web-chat-world`", () => {
    const first = webChatWorldId("Alice");
    const second = webChatWorldId("Alice");
    expect(first).toBe(second);
    expect(first).toBe(stringToUuid("Alice-web-chat-world"));
    expect(webChatWorldId("Bob")).not.toBe(first);
  });
});

describe("WEB_CONVERSATION_CHANNEL_PREFIX", () => {
  it("is the exact `web-conv-` marker used on persisted rooms", () => {
    expect(WEB_CONVERSATION_CHANNEL_PREFIX).toBe("web-conv-");
  });
});

describe("restoreConversationsFromDb", () => {
  it("returns 0 for an empty room queue and does not log", async () => {
    const worldIds: UUID[] = [];
    const memoryQueries: RestoreRuntimeOptions["memoryQueries"] = [];
    const logs: string[] = [];
    const target = emptyTarget({ log: (message) => logs.push(message) });

    const restored = await restoreConversationsFromDb(
      makeRuntime({ agentName: "Alice", worldIds, memoryQueries }),
      target,
    );

    expect(restored).toBe(0);
    expect(worldIds).toEqual([webChatWorldId("Alice")]);
    expect(memoryQueries).toEqual([]);
    expect(logs).toEqual([]);
    expect(target.conversations.size).toBe(0);
  });

  it("defaults a missing character name to Eliza when resolving the world", async () => {
    const worldIds: UUID[] = [];
    await restoreConversationsFromDb(makeRuntime({ worldIds }), emptyTarget());
    expect(worldIds).toEqual([webChatWorldId("Eliza")]);
  });

  it("treats a null character name as Eliza but keeps an empty string as-is", async () => {
    const nullWorlds: UUID[] = [];
    const emptyWorlds: UUID[] = [];
    await restoreConversationsFromDb(
      makeRuntime({ agentName: null, worldIds: nullWorlds }),
      emptyTarget(),
    );
    await restoreConversationsFromDb(
      makeRuntime({ agentName: "", worldIds: emptyWorlds }),
      emptyTarget(),
    );
    expect(nullWorlds).toEqual([webChatWorldId("Eliza")]);
    expect(emptyWorlds).toEqual([webChatWorldId("")]);
  });

  it("restores a single web-chat room and uses the latest message timestamp", async () => {
    const convId = "conv-single";
    const room = webRoom({ label: "single", convId, name: "Project chat" });
    const memoryQueries: RestoreRuntimeOptions["memoryQueries"] = [];
    const logs: string[] = [];
    const target = emptyTarget({ log: (message) => logs.push(message) });

    const restored = await restoreConversationsFromDb(
      makeRuntime({
        agentName: "Alice",
        rooms: [room],
        memoriesByRoom: new Map([[room.id, [{ createdAt: FROZEN_MS }]]]),
        memoryQueries,
      }),
      target,
    );

    expect(restored).toBe(1);
    expect(memoryQueries).toEqual([
      { roomId: room.id, tableName: "messages", limit: 1 },
    ]);
    expect(logs).toEqual(["Restored 1 conversation(s) from database"]);
    expect([...target.conversations.keys()]).toEqual([convId]);
    expect(target.conversations.get(convId)).toEqual({
      id: convId,
      title: "Project chat",
      roomId: room.id,
      createdAt: FROZEN_ISO,
      updatedAt: FROZEN_ISO,
    });
  });

  it("falls back to title Chat and frozen now when the room has no usable message time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN_ISO));

    const convId = "conv-empty-msgs";
    const room = webRoom({ label: "empty-msgs", convId, name: "" });
    const target = emptyTarget();

    const restored = await restoreConversationsFromDb(
      makeRuntime({
        rooms: [room],
        memoriesByRoom: new Map([[room.id, [{ createdAt: 0 }]]]),
      }),
      target,
    );

    expect(restored).toBe(1);
    expect(target.conversations.get(convId)).toEqual({
      id: convId,
      title: "Chat",
      roomId: room.id,
      createdAt: FROZEN_ISO,
      updatedAt: FROZEN_ISO,
    });
  });

  it("uses now when the latest memory exists but has no createdAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN_ISO));

    const convId = "conv-no-createdAt";
    const room = webRoom({ label: "no-createdAt", convId, name: "Named" });
    const target = emptyTarget();

    await restoreConversationsFromDb(
      makeRuntime({
        rooms: [room],
        memoriesByRoom: new Map([[room.id, [{}]]]),
      }),
      target,
    );

    expect(target.conversations.get(convId)?.createdAt).toBe(FROZEN_ISO);
  });

  it("skips non-string, non-prefixed, and prefix-only channel ids without reading memories", async () => {
    const memoryQueries: RestoreRuntimeOptions["memoryQueries"] = [];
    const logs: string[] = [];
    const rooms = [
      webRoom({ label: "numeric", channelId: 12 }),
      webRoom({ label: "nullish", channelId: null }),
      webRoom({ label: "other", channelId: "discord-room-1", name: "Discord" }),
      webRoom({
        label: "prefix-only",
        channelId: WEB_CONVERSATION_CHANNEL_PREFIX,
      }),
      webRoom({
        label: "wrong-case",
        channelId: "WEB-CONV-conv-case",
        name: "Case",
      }),
    ];

    const restored = await restoreConversationsFromDb(
      makeRuntime({ rooms, memoryQueries }),
      emptyTarget({ log: (message) => logs.push(message) }),
    );

    expect(restored).toBe(0);
    expect(memoryQueries).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("does not overwrite an already-loaded conversation or resurrect a deleted one", async () => {
    const loadedId = "conv-loaded";
    const deletedId = "conv-deleted";
    const loadedRoom = webRoom({
      label: "loaded",
      convId: loadedId,
      name: "Should not win",
    });
    const deletedRoom = webRoom({
      label: "deleted",
      convId: deletedId,
      name: "Deleted",
    });
    const extraDeleted = "conv-missing-from-rooms";
    const existing: ConversationMeta = {
      id: loadedId,
      title: "Already in memory",
      roomId: roomId("original"),
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    };
    const memoryQueries: RestoreRuntimeOptions["memoryQueries"] = [];
    const target = emptyTarget({
      conversations: new Map([[loadedId, existing]]),
      deletedConversationIds: new Set([deletedId, extraDeleted]),
    });

    const restored = await restoreConversationsFromDb(
      makeRuntime({ rooms: [loadedRoom, deletedRoom], memoryQueries }),
      target,
    );

    expect(restored).toBe(0);
    expect(memoryQueries).toEqual([]);
    expect(target.conversations.get(loadedId)).toEqual(existing);
    expect(target.conversations.has(deletedId)).toBe(false);
    expect(target.deletedConversationIds.has(extraDeleted)).toBe(true);
  });

  it("restores rooms in scan order and keeps only the first of a duplicate channel id", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN_ISO));

    const first = webRoom({ label: "first", convId: "conv-a", name: "First" });
    const duplicate = webRoom({
      label: "duplicate",
      convId: "conv-a",
      name: "Second copy",
    });
    const second = webRoom({
      label: "second",
      convId: "conv-b",
      name: "Second",
    });
    const memoryQueries: RestoreRuntimeOptions["memoryQueries"] = [];
    const logs: string[] = [];
    const target = emptyTarget({ log: (message) => logs.push(message) });

    const restored = await restoreConversationsFromDb(
      makeRuntime({ rooms: [first, duplicate, second], memoryQueries }),
      target,
    );

    expect(restored).toBe(2);
    expect(memoryQueries.map((query) => query.roomId)).toEqual([
      first.id,
      second.id,
    ]);
    expect([...target.conversations.keys()]).toEqual(["conv-a", "conv-b"]);
    expect(target.conversations.get("conv-a")?.title).toBe("First");
    expect(target.conversations.get("conv-a")?.roomId).toBe(first.id);
    expect(logs).toEqual(["Restored 2 conversation(s) from database"]);
  });

  it("replaces only the first channel-id prefix occurrence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN_ISO));

    const convId = "web-conv-nested";
    const room = webRoom({
      label: "nested-prefix",
      channelId: `${WEB_CONVERSATION_CHANNEL_PREFIX}${convId}`,
      name: "Nested",
    });
    const target = emptyTarget();

    await restoreConversationsFromDb(makeRuntime({ rooms: [room] }), target);

    expect([...target.conversations.keys()]).toEqual([convId]);
  });

  it("attaches sanitized room metadata only when the stored conversation id matches", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN_ISO));

    const matchingId = "conv-meta";
    const mismatchId = "conv-mismatch";
    const matching = webRoom({
      label: "meta-match",
      convId: matchingId,
      name: "Wallet",
      metadata: {
        webConversation: {
          conversationId: matchingId,
          scope: "page-wallet",
          unknown: "discarded",
        },
      },
    });
    const mismatched = webRoom({
      label: "meta-mismatch",
      convId: mismatchId,
      name: "Apps",
      metadata: {
        webConversation: {
          conversationId: "some-other-id",
          scope: "page-apps",
        },
      },
    });
    const target = emptyTarget();

    const restored = await restoreConversationsFromDb(
      makeRuntime({ rooms: [matching, mismatched] }),
      target,
    );

    expect(restored).toBe(2);
    expect(target.conversations.get(matchingId)?.metadata).toEqual({
      scope: "page-wallet",
    });
    expect(target.conversations.get(mismatchId)?.metadata).toBeUndefined();
  });

  it("does not require a log sink when conversations are restored", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN_ISO));

    const room = webRoom({
      label: "nolog",
      convId: "conv-nolog",
      name: "Quiet",
    });
    const target = emptyTarget();

    await expect(
      restoreConversationsFromDb(makeRuntime({ rooms: [room] }), target),
    ).resolves.toBe(1);
    expect(target.conversations.has("conv-nolog")).toBe(true);
  });
});
