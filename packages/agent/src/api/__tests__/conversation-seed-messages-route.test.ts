/**
 * Endpoint test for `POST /api/conversations/dev/seed-messages` — the dev-only
 * backdated-corpus seed route. Drives the real `handleConversationRoutes`
 * against a real `InMemoryDatabaseAdapter` (through a thin runtime shim) and
 * asserts the HTTP-boundary behaviour the route owns: production 404, bounded +
 * validated request body (garbage → 400), and a successful seed that lands real
 * backdated rows and registers the conversations in live state.
 *
 * The seeder + adapter under it are real; only the request/response plumbing is
 * synthesized. The generated search corpus itself is proven end-to-end against
 * the real ranker + window filter in `message-corpus-search.test.ts`.
 */

import type { Memory, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../../../core/src/database/inMemoryAdapter.ts";
import {
  type ConversationRouteContext,
  type ConversationRouteState,
  handleConversationRoutes,
} from "../conversation-routes.ts";
import type { ConversationMeta } from "../server-types.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000c1" as UUID;

function makeRuntime(adapter: InMemoryDatabaseAdapter): unknown {
  return {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    async ensureConnection(params: {
      roomId: UUID;
      roomName?: string;
      worldId?: UUID;
      source?: string;
      channelId?: string;
    }) {
      await adapter.createRooms([
        {
          id: params.roomId,
          agentId: AGENT_ID,
          name: params.roomName,
          source: params.source ?? "test",
          type: "dm",
          worldId: params.worldId,
          channelId: params.channelId,
        } as Parameters<InMemoryDatabaseAdapter["createRooms"]>[0][number],
      ]);
    },
    async createMemory(memory: Memory, tableName: string, unique?: boolean) {
      const [id] = await adapter.createMemories([
        { memory, tableName, ...(unique !== undefined ? { unique } : {}) },
      ]);
      return id;
    },
  };
}

function makeState(adapter: InMemoryDatabaseAdapter): ConversationRouteState {
  return {
    runtime: makeRuntime(adapter),
    conversations: new Map<string, ConversationMeta>(),
    deletedConversationIds: new Set<string>(),
    conversationRestorePromise: null,
  } as unknown as ConversationRouteState;
}

interface Captured {
  status: number;
  body: Record<string, unknown> & { error?: string };
}

function seedRequest(
  state: ConversationRouteState,
  body: unknown,
): Promise<Captured> {
  return new Promise((resolve) => {
    const captured: Partial<Captured> = {};
    const ctx = {
      req: {
        url: "/api/conversations/dev/seed-messages",
        headers: { host: "localhost" },
      },
      res: {},
      method: "POST",
      pathname: "/api/conversations/dev/seed-messages",
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

describe("POST /api/conversations/dev/seed-messages (route boundary)", () => {
  const prevNodeEnv = process.env.NODE_ENV;
  let adapter: InMemoryDatabaseAdapter;

  beforeEach(async () => {
    adapter = new InMemoryDatabaseAdapter();
    await adapter.initialize();
  });
  afterEach(() => {
    process.env.NODE_ENV = prevNodeEnv;
  });

  it("returns 404 in production (route existence is not advertised)", async () => {
    process.env.NODE_ENV = "production";
    const r = await seedRequest(makeState(adapter), {});
    expect(r.status).toBe(404);
  });

  it("rejects an out-of-bounds request body with 400", async () => {
    process.env.NODE_ENV = "test";
    // conversations max is 200; 500 is over the fat-finger guard.
    const r = await seedRequest(makeState(adapter), { conversations: 500 });
    expect(r.status).toBe(400);
  });

  it("rejects an unknown field (strict schema) with 400", async () => {
    process.env.NODE_ENV = "test";
    const r = await seedRequest(makeState(adapter), { bogus: 1 });
    expect(r.status).toBe(400);
  });

  it("rejects a non-integer count with 400", async () => {
    process.env.NODE_ENV = "test";
    const r = await seedRequest(makeState(adapter), {
      messagesPerConversation: 3.5,
    });
    expect(r.status).toBe(400);
  });

  it("seeds a real backdated corpus and registers the conversations in state", async () => {
    process.env.NODE_ENV = "test";
    const state = makeState(adapter);
    const r = await seedRequest(state, {
      conversations: 3,
      messagesPerConversation: 6,
      spanMonths: 13,
      seed: 7,
    });
    expect(r.status).toBe(200);
    expect(r.body.conversations).toBe(3);
    expect(r.body.messagesCreated).toBe(18);
    expect(Array.isArray(r.body.sampleQueries)).toBe(true);
    // Oldest message predates the anchor by more than a year.
    const oldest = r.body.oldestMessageAt as number;
    expect(Date.now() - oldest).toBeGreaterThan(365 * 24 * 60 * 60 * 1000);
    // The seeded conversations are now live + immediately listable.
    expect(state.conversations.size).toBe(3);

    // And the rows are really in the store: a topic keyword search hits them.
    const roomIds = Array.from(state.conversations.values()).map(
      (c) => c.roomId,
    );
    const query = (r.body.sampleQueries as string[])[0];
    const hits = await adapter.searchMessages({
      roomIds,
      query,
      tableName: "messages",
      limit: 100,
    });
    expect(hits.length).toBeGreaterThan(0);
  });

  it("returns 503 when the runtime is not available", async () => {
    process.env.NODE_ENV = "test";
    const state = {
      runtime: null,
      conversations: new Map(),
      deletedConversationIds: new Set<string>(),
      conversationRestorePromise: null,
    } as unknown as ConversationRouteState;
    const r = await seedRequest(state, {});
    expect(r.status).toBe(503);
  });
});
