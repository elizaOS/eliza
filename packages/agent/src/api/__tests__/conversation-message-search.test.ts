/**
 * Endpoint test for `GET /api/conversations/messages/search` — the keyword
 * message search added for #9955. Drives the real `handleConversationRoutes`
 * with a mocked runtime whose `getMemories` honours the `textContains` predicate
 * (as the SQL / in-memory adapters do), and asserts validation, ranking,
 * snippeting, role attribution, and accessible-conversation scoping.
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

function conv(id: string, roomId: UUID): ConversationMeta {
  return {
    id,
    title: `conv ${id}`,
    roomId,
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(1).toISOString(),
  };
}

function mem(
  text: string,
  roomId: UUID,
  entityId: UUID,
  createdAt: number,
): Memory {
  return {
    id: `${createdAt}0000-0000-0000-0000-00000000000a` as UUID,
    entityId,
    agentId,
    roomId,
    content: { text },
    createdAt,
  };
}

interface Captured {
  status: number;
  body: unknown;
}

function runSearch(
  url: string,
  state: ConversationRouteState,
): Promise<Captured> {
  return new Promise((resolve) => {
    const captured: Partial<Captured> = {};
    const ctx = {
      req: { url, headers: { host: "localhost" } },
      res: {},
      method: "GET",
      pathname: "/api/conversations/messages/search",
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
  const getMemories = vi.fn(async (params: { textContains?: string }) => {
    const needle = params.textContains?.toLowerCase() ?? "";
    return memories.filter((m) =>
      (m.content as { text: string }).text.toLowerCase().includes(needle),
    );
  });
  const runtime = { agentId, getMemories } as unknown as AgentRuntime;
  return {
    runtime,
    conversations: new Map(conversations.map((c) => [c.id, c])),
    deletedConversationIds: new Set<string>(),
  } as unknown as ConversationRouteState;
}

describe("GET /api/conversations/messages/search", () => {
  it("rejects a query shorter than 2 characters", async () => {
    const result = await runSearch(
      "/api/conversations/messages/search?q=a",
      makeState([], []),
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: expect.stringMatching(/2 char/),
    });
  });

  it("returns ranked, snippeted results with role attribution", async () => {
    const memories = [
      mem("we shipped the WebXR runtime today", roomA, userId, 3),
      mem("WebXR WebXR webxr everywhere", roomA, agentId, 2),
      mem("nothing relevant here", roomA, userId, 1),
      mem("webxr panels in room B", roomB, userId, 4),
    ];
    const result = await runSearch(
      "/api/conversations/messages/search?q=webxr",
      makeState(memories, [conv("c-a", roomA), conv("c-b", roomB)]),
    );
    expect(result.status).toBe(200);
    const body = result.body as {
      results: Array<{
        text: string;
        snippet: string;
        role: string;
        score: number;
        conversationId: string;
      }>;
      count: number;
    };
    // The non-matching message is dropped; the 3 webxr messages remain.
    expect(body.count).toBe(3);
    expect(
      body.results.every((r) => r.snippet.toLowerCase().includes("webxr")),
    ).toBe(true);
    // Ranked by score descending (recency breaks ties).
    for (let i = 1; i < body.results.length; i++) {
      expect(body.results[i - 1].score).toBeGreaterThanOrEqual(
        body.results[i].score,
      );
    }
    // Agent-authored message attributed to "assistant"; user to "user".
    const agentRow = body.results.find((r) => r.text.includes("everywhere"));
    expect(agentRow?.role).toBe("assistant");
    const userRow = body.results.find((r) => r.text.includes("today"));
    expect(userRow?.role).toBe("user");
    // Both rooms map to conversations.
    expect(new Set(body.results.map((r) => r.conversationId))).toEqual(
      new Set(["c-a", "c-b"]),
    );
  });

  it("excludes messages whose room is not an accessible conversation", async () => {
    const memories = [
      mem("webxr in a known room", roomA, userId, 2),
      mem("webxr in an orphan room", roomB, userId, 1),
    ];
    // Only roomA has a conversation in the map.
    const result = await runSearch(
      "/api/conversations/messages/search?q=webxr",
      makeState(memories, [conv("c-a", roomA)]),
    );
    const body = result.body as {
      results: Array<{ text: string }>;
      count: number;
    };
    expect(body.count).toBe(1);
    expect(body.results[0].text).toContain("known room");
  });
});
