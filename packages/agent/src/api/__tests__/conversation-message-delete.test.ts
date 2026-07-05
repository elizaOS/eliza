/**
 * Endpoint test for `DELETE /api/conversations/:id/messages/:messageId` — the
 * persistent single-message delete added for #13533. Unlike the truncate
 * primitive (which drops the target + everything after it, backing
 * edit-and-resend), this removes exactly one memory row and leaves the rest of
 * the thread intact.
 *
 * The mocked runtime models the store contract the handler relies on:
 * `getMemoriesByIds` for the id lookup + room-ownership check (mirroring the
 * `?around` forged-pivot guard), and `deleteManyMemories` for the actual
 * removal. Covers: happy-path delete (one row gone, rest intact + DELETE
 * fired), 404 for an unknown id, and the cross-room authz guard (a forged id
 * pointing at another room is a 404, never a foreign delete).
 */
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  type ConversationRouteContext,
  type ConversationRouteState,
  handleConversationRoutes,
} from "../conversation-routes.ts";
import type { ConversationMeta } from "../server-types.ts";

const agentId = "00000000-0000-0000-0000-0000000000a0" as UUID;
const roomA = "20000000-0000-0000-0000-00000000000a" as UUID;
const roomB = "20000000-0000-0000-0000-00000000000b" as UUID;
const userId = "10000000-0000-0000-0000-000000000001" as UUID;

/** Deterministic valid UUID encoding the createdAt so ids stay unique. */
function memId(createdAt: number): UUID {
  return `00000000-0000-0000-0000-${String(createdAt).padStart(12, "0")}` as UUID;
}

function mem(createdAt: number, roomId: UUID = roomA): Memory {
  return {
    id: memId(createdAt),
    entityId: userId,
    agentId,
    roomId,
    content: { text: `msg-${createdAt}` },
    createdAt,
  };
}

function conv(id: string, roomId: UUID): ConversationMeta {
  return {
    id,
    title: `conv ${id}`,
    roomId,
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(1).toISOString(),
  };
}

interface Captured {
  status: number;
  body: unknown;
}

function deleteMessage(
  convId: string,
  messageId: string,
  state: ConversationRouteState,
): Promise<Captured> {
  const url = `/api/conversations/${convId}/messages/${messageId}`;
  return new Promise((resolve) => {
    const captured: Partial<Captured> = {};
    const ctx = {
      req: { url, headers: { host: "localhost" } },
      res: {},
      method: "DELETE",
      pathname: `/api/conversations/${convId}/messages/${messageId}`,
      readJsonBody: vi.fn(),
      json: (_res: unknown, data: unknown, status = 200) => {
        captured.status = status;
        captured.body = data;
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

function makeState(
  memories: Memory[],
  conversations: ConversationMeta[],
): { state: ConversationRouteState; store: Memory[] } {
  // Live store so a delete is observable by a subsequent read (mirrors the
  // "reload does not resurrect it" acceptance criterion at the store layer).
  const store = [...memories];
  const getMemoriesByIds = vi.fn(async (ids: UUID[]) =>
    store.filter((m) => m.id !== undefined && ids.includes(m.id)),
  );
  const deleteManyMemories = vi.fn(async (ids: UUID[]) => {
    for (const id of ids) {
      const idx = store.findIndex((m) => m.id === id);
      if (idx >= 0) store.splice(idx, 1);
    }
  });
  const runtime = {
    agentId,
    getMemoriesByIds,
    deleteManyMemories,
  } as unknown as AgentRuntime;
  const state = {
    runtime,
    conversations: new Map(conversations.map((c) => [c.id, c])),
    deletedConversationIds: new Set<string>(),
    broadcastWs: vi.fn(),
    logBuffer: [],
  } as unknown as ConversationRouteState;
  return { state, store };
}

describe("DELETE /api/conversations/:id/messages/:messageId", () => {
  it("deletes exactly the target row, leaves the rest, and reports ok", async () => {
    const seeded = [mem(1), mem(2), mem(3)];
    const { state, store } = makeState(seeded, [conv("c-a", roomA)]);

    const result = await deleteMessage("c-a", memId(2), state);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, deletedCount: 1 });

    // The target is gone; its neighbors survive (single-row delete, not truncate).
    const remainingIds = store.map((m) => m.id);
    expect(remainingIds).not.toContain(memId(2));
    expect(remainingIds).toContain(memId(1));
    expect(remainingIds).toContain(memId(3));

    // The store delete actually fired for exactly the target id.
    const deleteMany = (
      state.runtime as unknown as {
        deleteManyMemories: { mock: { calls: Array<[UUID[]]> } };
      }
    ).deleteManyMemories;
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany.mock.calls[0][0]).toEqual([memId(2)]);

    // Listeners are notified so open transcripts drop the row.
    expect(state.broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({ type: "conversation-updated" }),
    );
  });

  it("returns 404 for a message id that does not exist", async () => {
    const { state, store } = makeState([mem(1), mem(2)], [conv("c-a", roomA)]);

    const result = await deleteMessage("c-a", memId(999), state);

    expect(result.status).toBe(404);
    expect((result.body as { error: string }).error).toMatch(/not found/i);
    // Nothing removed on a miss.
    expect(store).toHaveLength(2);
    const deleteMany = (
      state.runtime as unknown as {
        deleteManyMemories: { mock: { calls: unknown[] } };
      }
    ).deleteManyMemories;
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("returns 404 for a forged id pointing at another room (no cross-room delete)", async () => {
    const foreign = mem(5, roomB);
    const { state, store } = makeState(
      [mem(1, roomA), foreign],
      [conv("c-a", roomA)],
    );

    const result = await deleteMessage("c-a", memId(5), state);

    // The room-ownership check treats a foreign-room id as not-found.
    expect(result.status).toBe(404);
    // The foreign message survives — never deleted through another room's conv.
    expect(store.map((m) => m.id)).toContain(memId(5));
    const deleteMany = (
      state.runtime as unknown as {
        deleteManyMemories: { mock: { calls: unknown[] } };
      }
    ).deleteManyMemories;
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("returns 404 when the conversation itself is unknown", async () => {
    const { state } = makeState([mem(1)], [conv("c-a", roomA)]);

    const result = await deleteMessage("c-missing", memId(1), state);

    expect(result.status).toBe(404);
    expect((result.body as { error: string }).error).toMatch(
      /conversation not found/i,
    );
  });
});
