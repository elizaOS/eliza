/**
 * Endpoint test for `GET /api/conversations/:id/messages?around=<messageId>` —
 * the anchored-loading window added for #9955. The default handler returns only
 * the most-recent 200 turns, so a keyword-search hit older than that is never in
 * the loaded thread and can't be scrolled to. `?around` returns a window
 * CENTERED on the target (the pivot plus older + newer neighbors) so the jump
 * lands.
 *
 * The mocked runtime models the real getMemories adapter contract the helper
 * relies on: room-scope, inclusive `start`/`end` createdAt bounds,
 * `orderDirection`, and `limit` (so the half-window queries are meaningful), plus
 * `getMemoriesByIds` for the pivot lookup + room-ownership check.
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

/** Deterministic valid UUID encoding the createdAt so ids stay unique + sortable. */
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
  // Model the real getMemories contract used by loadConversationMessagesAround:
  // room-scope → inclusive start/end (createdAt) range → orderDirection → limit.
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

describe("GET /api/conversations/:id/messages?around", () => {
  // 250 turns; the default window is the newest 200 (createdAt 51..250).
  const seeded = Array.from({ length: 250 }, (_, i) => mem(i + 1));

  it("returns the default recent-200 window when `around` is absent", async () => {
    const result = await getMessages(
      "c-a",
      "",
      makeState(seeded, [conv("c-a", roomA)]),
    );
    expect(result.status).toBe(200);
    const ts = timestamps(result.body);
    expect(ts).toHaveLength(200);
    // Newest-200, sorted ascending: 51..250. The far-back target (10) is absent.
    expect(Math.min(...ts)).toBe(51);
    expect(Math.max(...ts)).toBe(250);
    expect(ts).not.toContain(10);
  });

  it("returns a window centered on a far-back `around` target (older than the recent-200)", async () => {
    const state = makeState(seeded, [conv("c-a", roomA)]);
    const result = await getMessages("c-a", `?around=${memId(10)}`, state);
    expect(result.status).toBe(200);
    const ts = timestamps(result.body);

    // The pivot AND its immediate neighbors load.
    expect(ts).toContain(10);
    expect(ts).toContain(9);
    expect(ts).toContain(11);

    // This is NOT the default recent-200: the newest turns are not in the
    // window, and the window starts from the conversation's true beginning.
    expect(ts).not.toContain(250);
    expect(Math.min(...ts)).toBe(1);
    // Pivot + up to 100 newer (11..110) + the 9 older (1..9) → ends at 110.
    expect(Math.max(...ts)).toBe(110);

    // The pivot was resolved by id (room-ownership check), not scanned.
    const byIds = (
      state.runtime as unknown as {
        getMemoriesByIds: { mock: { calls: Array<[UUID[]]> } };
      }
    ).getMemoriesByIds;
    expect(byIds.mock.calls[0][0]).toEqual([memId(10)]);
  });

  it("falls back to the recent window when `around` belongs to another room (no cross-room leak)", async () => {
    // A forged `around` id pointing at a roomB message must not pull roomB
    // content into roomA's thread.
    const foreign = mem(9999, roomB);
    const result = await getMessages(
      "c-a",
      `?around=${memId(9999)}`,
      makeState([...seeded, foreign], [conv("c-a", roomA)]),
    );
    expect(result.status).toBe(200);
    const ts = timestamps(result.body);
    expect(ts).toHaveLength(200);
    // Recent roomA window, not the foreign message.
    expect(ts).not.toContain(9999);
    expect(Math.max(...ts)).toBe(250);
  });

  it("ignores a malformed (non-UUID) `around` and serves the recent window", async () => {
    const result = await getMessages(
      "c-a",
      "?around=not-a-uuid",
      makeState(seeded, [conv("c-a", roomA)]),
    );
    expect(result.status).toBe(200);
    const ts = timestamps(result.body);
    expect(ts).toHaveLength(200);
    expect(Math.max(...ts)).toBe(250);
  });
});
