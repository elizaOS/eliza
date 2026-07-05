/**
 * Endpoint test for `GET /api/conversations/:id/messages?before=<createdAt>` —
 * the load-older pagination added for the infinite upward scroll (#13532). The
 * default handler returns only the newest 200 turns; `?before=<cursor>` returns
 * a page STRICTLY OLDER than the cursor (the createdAt of the client's current
 * oldest message) plus a `hasMore` flag so the client can stop paging at the
 * true top.
 *
 * The mocked runtime models the real getMemories adapter contract the helper
 * relies on: room-scope, inclusive `end` createdAt bound, `orderDirection`, and
 * `limit` (so the +1 hasMore probe is meaningful).
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
const userId = "10000000-0000-0000-0000-000000000001" as UUID;

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

function getMessages(
  convId: string,
  query: string,
  state: ConversationRouteState,
): Promise<Captured> {
  const url = `/api/conversations/${convId}/messages${query}`;
  return new Promise((resolve) => {
    const captured: Partial<Captured> = {};
    const ctx = {
      req: { url, headers: { host: "localhost" } },
      res: {},
      method: "GET",
      pathname: `/api/conversations/${convId}/messages`,
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
): ConversationRouteState {
  // Model the real getMemories contract used by loadConversationMessagesBefore:
  // room-scope → inclusive end (createdAt) upper bound → orderDirection → limit.
  const getMemories = vi.fn(
    async (params: {
      roomId?: UUID;
      start?: number;
      end?: number;
      limit?: number;
      orderDirection?: "asc" | "desc";
    }) => {
      let rows = memories.filter((m) => m.roomId === params.roomId);
      if (params.start !== undefined) {
        rows = rows.filter((m) => (m.createdAt ?? 0) >= (params.start ?? 0));
      }
      if (params.end !== undefined) {
        rows = rows.filter((m) => (m.createdAt ?? 0) <= (params.end ?? 0));
      }
      const dir = params.orderDirection ?? "desc";
      rows = [...rows].sort((a, b) =>
        dir === "asc"
          ? (a.createdAt ?? 0) - (b.createdAt ?? 0)
          : (b.createdAt ?? 0) - (a.createdAt ?? 0),
      );
      return params.limit !== undefined ? rows.slice(0, params.limit) : rows;
    },
  );
  const getMemoriesByIds = vi.fn(async (ids: UUID[]) =>
    memories.filter((m) => m.id !== undefined && ids.includes(m.id)),
  );
  const runtime = {
    agentId,
    getMemories,
    getMemoriesByIds,
  } as unknown as AgentRuntime;
  return {
    runtime,
    conversations: new Map(conversations.map((c) => [c.id, c])),
    deletedConversationIds: new Set<string>(),
    logBuffer: [],
  } as unknown as ConversationRouteState;
}

function timestamps(body: unknown): number[] {
  return (body as { messages: Array<{ timestamp: number }> }).messages.map(
    (m) => m.timestamp,
  );
}

function hasMore(body: unknown): boolean | undefined {
  return (body as { hasMore?: boolean }).hasMore;
}

describe("GET /api/conversations/:id/messages?before", () => {
  // 250 turns; default window is newest-200 (createdAt 51..250).
  const seeded = Array.from({ length: 250 }, (_, i) => mem(i + 1));

  it("returns a page STRICTLY OLDER than the cursor, newest-first from the store then sorted ascending", async () => {
    // Cursor = 100: expect the 50 turns just below it (50..99), ascending.
    const result = await getMessages(
      "c-a",
      `?before=100&limit=50`,
      makeState(seeded, [conv("c-a", roomA)]),
    );
    expect(result.status).toBe(200);
    const ts = timestamps(result.body);
    expect(ts).toHaveLength(50);
    // Strictly older than the cursor: 100 itself is excluded.
    expect(ts).not.toContain(100);
    expect(Math.max(...ts)).toBe(99);
    expect(Math.min(...ts)).toBe(50);
    // Ascending order for the transcript renderer.
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it("reports hasMore=true when older turns remain beyond the page", async () => {
    // Cursor 100, page 50 → 50..99 returned, turns 1..49 still older.
    const result = await getMessages(
      "c-a",
      `?before=100&limit=50`,
      makeState(seeded, [conv("c-a", roomA)]),
    );
    expect(hasMore(result.body)).toBe(true);
  });

  it("reports hasMore=false at the true top (fewer older turns than the page)", async () => {
    // Cursor 30, page 50 → only 1..29 are older (29 turns < 50) → no more.
    const result = await getMessages(
      "c-a",
      `?before=30&limit=50`,
      makeState(seeded, [conv("c-a", roomA)]),
    );
    expect(result.status).toBe(200);
    const ts = timestamps(result.body);
    expect(ts).toHaveLength(29);
    expect(Math.min(...ts)).toBe(1);
    expect(Math.max(...ts)).toBe(29);
    expect(hasMore(result.body)).toBe(false);
  });

  it("returns an empty page with hasMore=false when the cursor is at the oldest turn", async () => {
    // Cursor 1 (the oldest) → nothing strictly older.
    const result = await getMessages(
      "c-a",
      `?before=1&limit=50`,
      makeState(seeded, [conv("c-a", roomA)]),
    );
    expect(result.status).toBe(200);
    expect(timestamps(result.body)).toHaveLength(0);
    expect(hasMore(result.body)).toBe(false);
  });

  it("clamps an oversized limit to the recent-window cap", async () => {
    // limit=9999 → clamped to 200; cursor 250 → older turns 50..249 (200 rows),
    // and hasMore=true (49 older still remain: 1..49).
    const result = await getMessages(
      "c-a",
      `?before=250&limit=9999`,
      makeState(seeded, [conv("c-a", roomA)]),
    );
    expect(result.status).toBe(200);
    const ts = timestamps(result.body);
    expect(ts).toHaveLength(200);
    expect(Math.max(...ts)).toBe(249);
    expect(Math.min(...ts)).toBe(50);
    expect(hasMore(result.body)).toBe(true);
  });

  it("ignores a malformed (non-numeric) before and serves the recent window without a hasMore flag", async () => {
    const result = await getMessages(
      "c-a",
      "?before=not-a-number",
      makeState(seeded, [conv("c-a", roomA)]),
    );
    expect(result.status).toBe(200);
    const ts = timestamps(result.body);
    expect(ts).toHaveLength(200);
    expect(Math.max(...ts)).toBe(250);
    // Recent window path omits pagination state.
    expect(hasMore(result.body)).toBeUndefined();
  });

  it("prefers around over before when both are present (a centered jump owns its window)", async () => {
    const state = makeState(seeded, [conv("c-a", roomA)]);
    const result = await getMessages(
      "c-a",
      `?around=${memId(10)}&before=5`,
      state,
    );
    expect(result.status).toBe(200);
    const ts = timestamps(result.body);
    // The around window centers on 10 (includes 10 + neighbors), NOT a
    // strictly-older-than-5 page.
    expect(ts).toContain(10);
    // around path omits hasMore.
    expect(hasMore(result.body)).toBeUndefined();
  });
});
