/**
 * Same-millisecond messages must follow UUID order. A localeCompare tie-break
 * treats the lower id as newer, so a retry or an inbox page can surface the
 * other message.
 */
import type http from "node:http";
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { getRecentVisibleAssistantMemorySince } from "../src/api/chat-routes.ts";
import { handleInboxRoute } from "../src/api/inbox-routes.ts";

const AGENT = "00000000-0000-4000-8000-0000000000aa" as UUID;
const USER = "00000000-0000-4000-8000-0000000000bb" as UUID;
const ROOM = "00000000-0000-4000-8000-0000000000cc" as UUID;
const LOWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const UPPER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
const CREATED_AT = 1_700_000_000_000;

function message(id: UUID, text: string, entityId: UUID): Memory {
  return {
    id,
    entityId,
    agentId: AGENT,
    roomId: ROOM,
    createdAt: CREATED_AT,
    content: { text, source: "telegram" },
  } as Memory;
}

describe("same-millisecond latest message selection", () => {
  it("replays the higher UUID assistant turn", async () => {
    const runtime = {
      agentId: AGENT,
      getMemories: async () => [
        message(LOWER, "lower turn", AGENT),
        message(UPPER, "upper turn", AGENT),
      ],
    } as unknown as AgentRuntime;
    const selected = await getRecentVisibleAssistantMemorySince(
      runtime,
      ROOM,
      CREATED_AT,
      0,
    );
    expect(selected).toEqual({ id: UPPER, text: "upper turn" });
  });

  it("keeps the higher UUID when the inbox page holds one of a tie", async () => {
    const runtime = {
      agentId: AGENT,
      getRoom: async () => ({ id: ROOM }),
      getMemories: async () => [
        message(LOWER, "lower inbox", USER),
        message(UPPER, "upper inbox", USER),
      ],
    } as unknown as AgentRuntime;
    let body: { messages?: Array<{ id: string; text: string }> } | undefined;
    await handleInboxRoute(
      {
        url: `/api/inbox/messages?limit=1&roomId=${ROOM}&sources=telegram`,
      } as http.IncomingMessage,
      {} as http.ServerResponse,
      "/api/inbox/messages",
      "GET",
      { runtime },
      {
        json: (_res, payload) => {
          body = payload as typeof body;
        },
        error: (_res, message) => {
          throw new Error(String(message));
        },
      },
    );
    expect(body?.messages?.map((item) => item.id)).toEqual([UPPER]);
    expect(body?.messages?.[0]?.text).toBe("upper inbox");
  });
});
