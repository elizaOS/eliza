/**
 * Concurrency test for `POST /api/conversations/:id/greeting` — the
 * duplicate-greeting root cause. The greeting ensure is a read-check-then-write
 * (getMemories scan → persist) with no room-level uniqueness on (room, source):
 * two OVERLAPPING callers both read an empty room and both persist an identical
 * greeting row, which paints the doubled "Hey, I'm <agent>" bubble and leaks a
 * duplicate row into model context. Drives the real `handleConversationRoutes`
 * against a real `InMemoryDatabaseAdapter` (thin runtime shim) and asserts the
 * room-history ownership holds: concurrent requests store exactly one greeting,
 * and create-with-greeting cannot deadlock a direct greeting request.
 */

import type { Memory, UUID } from "@elizaos/core";
import {
  ChannelType,
  MESSAGE_SOURCE_AGENT_GREETING,
  RoomHandlerQueue,
} from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../../../core/src/database/inMemoryAdapter.ts";
import {
  type ConversationRouteContext,
  type ConversationRouteState,
  handleConversationRoutes,
} from "../conversation-routes.ts";
import type { ConversationMeta } from "../server-types.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000c1" as UUID;
const CONV_ID = "11111111-1111-4111-8111-111111111111";
const ROOM_ID = "22222222-2222-4222-8222-222222222222" as UUID;

function makeRuntime(
  adapter: InMemoryDatabaseAdapter,
  beforeGetMemories?: (roomId: UUID) => Promise<void>,
): unknown {
  return {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    roomHandlerQueue: new RoomHandlerQueue(),
    async ensureConnection(params: { roomId: UUID; roomName?: string }) {
      await adapter.createRooms([
        {
          id: params.roomId,
          agentId: AGENT_ID,
          name: params.roomName,
          source: "test",
          type: ChannelType.DM,
        } as Parameters<InMemoryDatabaseAdapter["createRooms"]>[0][number],
      ]);
    },
    async createMemory(memory: Memory, tableName: string) {
      const [id] = await adapter.createMemories([{ memory, tableName }]);
      return id;
    },
    async getMemories(params: {
      roomId: UUID;
      tableName: string;
      limit?: number;
    }) {
      await beforeGetMemories?.(params.roomId);
      return adapter.getMemories({
        roomId: params.roomId,
        tableName: params.tableName,
        count: params.limit,
      });
    },
    // World/room plumbing exercised by ensureConversationRoom on the greeting
    // route. The world is a mutable in-shim record so ownership/role writes
    // round-trip like the real adapter's.
    __worlds: new Map<string, Record<string, unknown>>(),
    async getWorld(worldId: UUID) {
      const worlds = (this as { __worlds: Map<string, unknown> }).__worlds;
      if (!worlds.has(worldId)) {
        worlds.set(worldId, {
          id: worldId,
          agentId: AGENT_ID,
          name: "test-world",
          serverId: "test-server",
          metadata: {},
        });
      }
      return worlds.get(worldId);
    },
    async updateWorld(world: { id: UUID }) {
      (this as { __worlds: Map<string, unknown> }).__worlds.set(
        world.id,
        world,
      );
    },
    async getRoom(roomId: UUID) {
      const rooms = await adapter.getRoomsByIds([roomId]);
      return rooms?.[0] ?? null;
    },
    adapter: {
      async updateRoom() {
        /* room metadata refresh is irrelevant to the greeting invariant */
      },
    },
  };
}

function makeState(
  adapter: InMemoryDatabaseAdapter,
  beforeGetMemories?: (roomId: UUID) => Promise<void>,
): ConversationRouteState {
  const conv: ConversationMeta = {
    id: CONV_ID,
    title: "Chat",
    roomId: ROOM_ID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as ConversationMeta;
  return {
    runtime: makeRuntime(adapter, beforeGetMemories),
    agentName: "Eliza",
    config: { ui: {} },
    conversations: new Map<string, ConversationMeta>([[CONV_ID, conv]]),
    deletedConversationIds: new Set<string>(),
    conversationRestorePromise: null,
  } as unknown as ConversationRouteState;
}

interface Captured {
  status: number;
  body: Record<string, unknown> & { error?: string; text?: string };
}

function greetingRequest(
  state: ConversationRouteState,
  conversationId = CONV_ID,
): Promise<Captured> {
  return new Promise((resolve) => {
    const captured: Partial<Captured> = {};
    const ctx = {
      req: {
        url: `/api/conversations/${conversationId}/greeting`,
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      },
      res: {},
      method: "POST",
      pathname: `/api/conversations/${conversationId}/greeting`,
      readJsonBody: () => Promise.resolve({}),
      json: (_res: unknown, data: unknown, status = 200) => {
        captured.status = status;
        captured.body = data as Captured["body"];
        resolve(captured as Captured);
      },
      error: (_res: unknown, message: string, status = 500) => {
        captured.status = status;
        captured.body = { error: message };
        resolve(captured as Captured);
      },
      state,
    } as unknown as ConversationRouteContext;
    void handleConversationRoutes(ctx);
  });
}

function createConversationRequest(
  state: ConversationRouteState,
): Promise<Captured> {
  return new Promise((resolve) => {
    const captured: Partial<Captured> = {};
    const ctx = {
      req: {
        url: "/api/conversations",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      },
      res: {},
      method: "POST",
      pathname: "/api/conversations",
      readJsonBody: () =>
        Promise.resolve({ title: "Greeting race", includeGreeting: true }),
      json: (_res: unknown, data: unknown, status = 200) => {
        captured.status = status;
        captured.body = data as Captured["body"];
        resolve(captured as Captured);
      },
      error: (_res: unknown, message: string, status = 500) => {
        captured.status = status;
        captured.body = { error: message };
        resolve(captured as Captured);
      },
      state,
    } as unknown as ConversationRouteContext;
    void handleConversationRoutes(ctx);
  });
}

async function greetingRows(
  adapter: InMemoryDatabaseAdapter,
  roomId = ROOM_ID,
) {
  const memories = await adapter.getMemories({
    roomId,
    tableName: "messages",
    count: 50,
  });
  return memories.filter(
    (m) =>
      (m.content as Record<string, unknown> | undefined)?.source ===
      MESSAGE_SOURCE_AGENT_GREETING,
  );
}

describe("POST /api/conversations/:id/greeting — concurrent ensure coalescing", () => {
  let adapter: InMemoryDatabaseAdapter;

  beforeEach(async () => {
    adapter = new InMemoryDatabaseAdapter();
    await adapter.initialize();
  });

  it("two CONCURRENT greeting requests persist exactly one greeting row", async () => {
    const state = makeState(adapter);
    const [a, b] = await Promise.all([
      greetingRequest(state),
      greetingRequest(state),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.text).toBeTruthy();
    // Coalesced callers observe the SAME committed greeting.
    expect(b.body.text).toBe(a.body.text);

    const rows = await greetingRows(adapter);
    expect(rows).toHaveLength(1);
  });

  it("a SEQUENTIAL second request returns the stored greeting without re-persisting", async () => {
    const state = makeState(adapter);
    const first = await greetingRequest(state);
    const second = await greetingRequest(state);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.text).toBe(first.body.text);
    // Late caller reads the existing row (persisted:false semantics preserved).
    expect(second.body.persisted).toBe(false);

    const rows = await greetingRows(adapter);
    expect(rows).toHaveLength(1);
  });

  it("serializes create-with-greeting and the greeting route without a single-flight cycle", async () => {
    let releaseRead: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let notifyReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      notifyReadStarted = resolve;
    });
    let blockedRoomId: UUID | undefined;
    const state = makeState(adapter, async (roomId) => {
      if (!blockedRoomId) {
        blockedRoomId = roomId;
        notifyReadStarted?.();
        await readGate;
      }
    });

    const create = createConversationRequest(state);
    await readStarted;
    const created = [...state.conversations.values()].find(
      (conversation) => conversation.id !== CONV_ID,
    );
    expect(created?.roomId).toBe(blockedRoomId);
    if (!created) throw new Error("created conversation missing");

    let greetingSettled = false;
    const greeting = greetingRequest(state, created.id).then((result) => {
      greetingSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(greetingSettled).toBe(false);

    releaseRead?.();
    const [createdResponse, greetingResponse] = await Promise.all([
      create,
      greeting,
    ]);
    expect(createdResponse.status).toBe(200);
    expect(greetingResponse.status).toBe(200);
    expect(greetingResponse.body.text).toBeTruthy();
    expect(await greetingRows(adapter, created.roomId)).toHaveLength(1);
  });
});
