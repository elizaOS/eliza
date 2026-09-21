/**
 * Regression for `POST /api/conversations` when room initialization fails:
 * the handler must answer 500 and leave the live conversation list unchanged
 * instead of registering a phantom conversation with no backing room. Drives
 * the real `handleConversationRoutes` against a real `InMemoryDatabaseAdapter`
 * behind a thin runtime shim whose `ensureConnection` is scripted to fail;
 * deterministic, no network or model.
 */

import type { Memory, UUID } from "@elizaos/core";
import { ChannelType } from "@elizaos/core";
import { InMemoryDatabaseAdapter } from "@elizaos/testing/in-memory-adapter";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type ConversationRouteContext,
  type ConversationRouteState,
  handleConversationRoutes,
} from "../conversation-routes.ts";
import type { ConversationMeta } from "../server-types.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000c2" as UUID;

function makeRuntime(
  adapter: InMemoryDatabaseAdapter,
  ensureConnectionFailure: Error | null,
): unknown {
  return {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    async ensureConnection(params: { roomId: UUID; roomName?: string }) {
      if (ensureConnectionFailure) {
        throw ensureConnectionFailure;
      }
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
      return adapter.getMemories({
        roomId: params.roomId,
        tableName: params.tableName,
        count: params.limit,
      });
    },
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
        /* room metadata refresh is irrelevant to the registration invariant */
      },
    },
  };
}

function makeState(
  adapter: InMemoryDatabaseAdapter,
  ensureConnectionFailure: Error | null,
): ConversationRouteState {
  return {
    runtime: makeRuntime(adapter, ensureConnectionFailure),
    agentName: "Eliza",
    config: { ui: {} },
    conversations: new Map<string, ConversationMeta>(),
    deletedConversationIds: new Set<string>(),
    conversationRestorePromise: null,
    adminEntityId: null,
    chatUserId: null,
    logBuffer: [],
    activeChatTurnCount: 0,
    broadcastWs: null,
  } as unknown as ConversationRouteState;
}

interface Captured {
  status: number;
  body: Record<string, unknown> & {
    error?: string;
    conversation?: ConversationMeta;
    conversations?: ConversationMeta[];
  };
}

function request(
  state: ConversationRouteState,
  method: "GET" | "POST",
  body: Record<string, unknown> = {},
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
      method,
      pathname: "/api/conversations",
      readJsonBody: () => Promise.resolve(body),
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

describe("POST /api/conversations — failed room initialization", () => {
  let adapter: InMemoryDatabaseAdapter;

  beforeEach(async () => {
    adapter = new InMemoryDatabaseAdapter();
    await adapter.initialize();
  });

  it("answers 500 and leaves no phantom conversation behind", async () => {
    const state = makeState(adapter, new Error("room queue unavailable"));

    const created = await request(state, "POST", { title: "x" });

    expect(created.status).toBe(500);
    expect(created.body.error).toContain("Failed to initialize conversation");
    expect(created.body.error).toContain("room queue unavailable");
    expect(state.conversations.size).toBe(0);

    const listed = await request(state, "GET");
    expect(listed.status).toBe(200);
    expect(listed.body.conversations).toEqual([]);
  });

  it("does not evict an existing conversation to make room for a failed create", async () => {
    const state = makeState(adapter, new Error("room queue unavailable"));
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    for (let index = 0; index < 500; index += 1) {
      const stamp = new Date(base + index * 60_000).toISOString();
      const id = `existing-${index}`;
      state.conversations.set(id, {
        id,
        title: `Chat ${index}`,
        roomId:
          `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` as UUID,
        createdAt: stamp,
        updatedAt: stamp,
      } as ConversationMeta);
    }
    const before = [...state.conversations.keys()];

    const created = await request(state, "POST", { title: "x" });

    expect(created.status).toBe(500);
    expect([...state.conversations.keys()]).toEqual(before);
  });

  it("registers the conversation once room initialization succeeds", async () => {
    const state = makeState(adapter, null);

    const created = await request(state, "POST", { title: "x" });

    expect(created.status).toBe(200);
    const conversation = created.body.conversation;
    expect(conversation).toBeDefined();
    expect(state.conversations.get(conversation?.id ?? "")).toBe(conversation);
    expect(
      await adapter.getRoomsByIds([conversation?.roomId as UUID]),
    ).toHaveLength(1);

    const listed = await request(state, "GET");
    expect(listed.body.conversations?.map((c) => c.id)).toEqual([
      conversation?.id,
    ]);
  });
});
