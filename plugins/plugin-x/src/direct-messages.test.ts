/**
 * DM auto-reply egress: a reply longer than X's per-message DM limit must go
 * out as ordered parts, and a failure after an accepted part must keep the
 * no-replay marker. The harness runs the real `TwitterDirectMessageClient`
 * poll against an in-memory cache and a recorded DM transport.
 */
import {
  ChannelType,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientBase } from "./base";
import { TwitterDirectMessageClient } from "./direct-messages";
import type { TwitterClientState } from "./types";
import { X_MAX_DM_LENGTH } from "./utils";

const OWN_USER_ID = "999";
const SENDER_ID = "111";
const EVENT_ID = "200";
const STATE_PREFIX = `twitter/default/${OWN_USER_ID}`;
const CURSOR_KEY = `${STATE_PREFIX}/dm_cursor`;
const SETTLED_KEY = `${STATE_PREFIX}/dm_settled/${EVENT_ID}`;

const STORED_REPLY_ID = "55555555-5555-4555-8555-555555555555" as UUID;

function createHarness(
  reply: string,
  sendDmToParticipant: ReturnType<typeof vi.fn>,
  groupConversationId?: string,
  options?: { prestoreReply?: boolean },
) {
  const cache = new Map<string, unknown>([[CURSOR_KEY, "100"]]);
  const memories = new Map<string, Memory>();
  const createMemory = vi.fn(async (memory: Memory) => {
    memories.set(String(memory.id), memory);
  });
  const getMemoryById = vi.fn(async (id: string) => memories.get(id) ?? null);
  const updateMemory = vi.fn(
    async (next: {
      id: UUID;
      content: Content;
      metadata?: Memory["metadata"];
    }) => {
      const existing = memories.get(String(next.id));
      if (!existing) return false;
      memories.set(String(next.id), {
        ...existing,
        content: next.content,
        metadata: next.metadata,
      });
      return true;
    },
  );
  const handleMessage = vi.fn(
    async (
      _runtime: IAgentRuntime,
      message: Memory,
      callback: HandlerCallback,
    ) => {
      if (options?.prestoreReply) {
        memories.set(STORED_REPLY_ID, {
          id: STORED_REPLY_ID,
          entityId: _runtime.agentId,
          agentId: _runtime.agentId,
          roomId: message.roomId,
          content: { text: reply, responseId: STORED_REPLY_ID },
        });
        await callback({ text: reply, responseId: STORED_REPLY_ID });
        return { responseMessages: [] };
      }
      await callback({ text: reply } as Content);
      return { responseMessages: [] };
    },
  );
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000aa" as UUID,
    character: { name: "Agent" },
    createMemory,
    ensureConnection: vi.fn(async () => undefined),
    ensureRoomExists: vi.fn(async () => undefined),
    ensureWorldExists: vi.fn(async () => undefined),
    getCache: vi.fn(async (key: string) => cache.get(key)),
    setCache: vi.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    }),
    deleteCache: vi.fn(async (key: string) => cache.delete(key)),
    getSetting: vi.fn(() => undefined),
    getMemoryById,
    updateMemory,
    reportError: vi.fn(),
    messageService: { handleMessage },
  };
  const apiClient = {
    v2: {
      listDmEvents: vi.fn(async () => ({
        events: [
          {
            id: EVENT_ID,
            sender_id: SENDER_ID,
            dm_conversation_id:
              groupConversationId ?? `${SENDER_ID}-${OWN_USER_ID}`,
            text: "tell me everything",
            event_type: "MessageCreate",
          },
        ],
        includes: {
          users: [{ id: SENDER_ID, username: "alice", name: "Alice" }],
        },
        done: true,
      })),
      sendDmToParticipant,
      sendDmInConversation: vi.fn(async () => ({ dm_event_id: "301" })),
    },
  };
  const client = {
    accountId: "default",
    twitterClient: {
      withAuthenticatedSession: vi.fn(
        async (operation: (session: unknown) => Promise<unknown>) =>
          operation({
            client: apiClient,
            profile: { userId: OWN_USER_ID },
            revision: 1,
          }),
      ),
      isAuthenticatedSessionCurrent: vi.fn(() => true),
    },
  };
  const dm = new TwitterDirectMessageClient(
    client as unknown as ClientBase,
    runtime as unknown as IAgentRuntime,
    { TWITTER_DM_POLICY: "open" } as TwitterClientState,
  );
  const pollOnce = async () => {
    await dm.start();
    await dm.stop();
  };
  return {
    cache,
    createMemory,
    handleMessage,
    memories,
    pollOnce,
    runtime,
    sendDmInConversation: apiClient.v2.sendDmInConversation,
  };
}

/** Mirrors twitter-api-v2's ApiResponseError: HTTP status in `code`, body in `data`. */
function rejection(status: number, data?: Record<string, unknown>): Error {
  return Object.assign(new Error(`Request failed with code ${status}`), {
    code: status,
    ...(data ? { data } : {}),
  });
}

describe("X DM auto-reply over the per-message length limit", () => {
  beforeEach(() => {
    logger.debug = vi.fn();
    logger.info = vi.fn();
    logger.warn = vi.fn();
    logger.error = vi.fn();
  });

  it("sends a reply over the limit as ordered parts and settles on the first event id", async () => {
    const reply = `${"a".repeat(X_MAX_DM_LENGTH - 1)}😀${"b".repeat(X_MAX_DM_LENGTH)}tail`;
    let sendCount = 0;
    const send = vi.fn(async () => {
      sendCount += 1;
      return { dm_event_id: `30${sendCount}` };
    });
    const { cache, createMemory, pollOnce, runtime } = createHarness(
      reply,
      send,
    );

    await pollOnce();

    expect(runtime.reportError).not.toHaveBeenCalled();
    const parts = send.mock.calls.map(
      ([recipient, body]: [string, { text: string }]) => {
        expect(recipient).toBe(SENDER_ID);
        return body.text;
      },
    );
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(Array.from(part).length).toBeLessThanOrEqual(X_MAX_DM_LENGTH);
    }
    expect(parts.join("")).toBe(reply);
    expect(cache.get(SETTLED_KEY)).toBe("delivered:301");
    expect(cache.get(CURSOR_KEY)).toBe(EVENT_ID);
    const responseMemory = createMemory.mock.calls
      .map(([memory]) => memory)
      .find((memory) => memory.metadata?.fromBot === true);
    expect(responseMemory?.content.text).toBe(reply);
    expect(responseMemory?.metadata?.messageIdFull).toBe("301");
  });

  it("stores a delivered reply once when the message service already saved it", async () => {
    const reply = "hello once";
    const send = vi.fn(async () => ({ dm_event_id: "301" }));
    const { memories, pollOnce, runtime } = createHarness(
      reply,
      send,
      undefined,
      {
        prestoreReply: true,
      },
    );

    await pollOnce();

    expect(runtime.reportError).not.toHaveBeenCalled();
    const replyRows = [...memories.values()].filter(
      (memory) => memory.content.text === reply,
    );
    expect(replyRows).toHaveLength(1);
    const botRows = replyRows.filter(
      (memory) => memory.metadata?.fromBot === true,
    );
    expect(botRows.map((memory) => memory.content.text)).toEqual([reply]);
    expect(botRows.map((memory) => memory.id)).toEqual([STORED_REPLY_ID]);
    expect(botRows[0]?.metadata?.messageIdFull).toBe("301");
  });

  it("keeps a reply within the limit as one request", async () => {
    const reply = "c".repeat(X_MAX_DM_LENGTH);
    const send = vi.fn(async () => ({ dm_event_id: "301" }));
    const { cache, pollOnce } = createHarness(reply, send);

    await pollOnce();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(SENDER_ID, { text: reply });
    expect(cache.get(SETTLED_KEY)).toBe("delivered:301");
  });

  it("stores a group DM reply with the group channel type", async () => {
    const sendToParticipant = vi.fn();
    const groupConversationId = "123456789012345";
    const { createMemory, pollOnce, sendDmInConversation } = createHarness(
      "group reply",
      sendToParticipant,
      groupConversationId,
    );

    await pollOnce();

    expect(sendToParticipant).not.toHaveBeenCalled();
    expect(sendDmInConversation).toHaveBeenCalledWith(groupConversationId, {
      text: "group reply",
    });
    const responseMemory = createMemory.mock.calls
      .map(([memory]) => memory)
      .find((memory) => memory.metadata?.fromBot === true);
    expect(responseMemory?.content.channelType).toBe(ChannelType.GROUP);
    expect(responseMemory?.metadata?.chatType).toBe(ChannelType.GROUP);
  });

  it("keeps the no-replay marker when a later part is rejected, so accepted parts are not resent", async () => {
    const reply = "d".repeat(X_MAX_DM_LENGTH + 5);
    const send = vi
      .fn()
      .mockResolvedValueOnce({ dm_event_id: "301" })
      .mockRejectedValueOnce(rejection(400));
    const { cache, handleMessage, pollOnce, runtime } = createHarness(
      reply,
      send,
    );

    await pollOnce();

    expect(send).toHaveBeenCalledTimes(2);
    expect(runtime.reportError).toHaveBeenCalledTimes(1);
    expect(cache.get(SETTLED_KEY)).toBe("indeterminate");
    expect(cache.get(CURSOR_KEY)).toBe("100");

    await pollOnce();

    expect(send).toHaveBeenCalledTimes(2);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(cache.get(CURSOR_KEY)).toBe(EVENT_ID);
  });

  it("reopens the event when the first part is rate limited", async () => {
    const reply = "e".repeat(X_MAX_DM_LENGTH + 5);
    const send = vi.fn().mockRejectedValueOnce(rejection(429));
    const { cache, pollOnce, runtime } = createHarness(reply, send);

    await pollOnce();

    expect(send).toHaveBeenCalledTimes(1);
    expect(runtime.reportError).toHaveBeenCalledTimes(1);
    expect(cache.has(SETTLED_KEY)).toBe(false);
    expect(cache.get(CURSOR_KEY)).toBe("100");
  });

  it("moves past an event whose reply X refuses for this recipient, so later DMs are not held behind it", async () => {
    const send = vi.fn().mockRejectedValue(
      rejection(403, {
        title: "Forbidden",
        detail: "You are not allowed to send a message to this user.",
        type: "about:blank",
        status: 403,
      }),
    );
    const { cache, handleMessage, pollOnce, runtime } = createHarness(
      "f",
      send,
    );

    await pollOnce();

    expect(runtime.reportError).toHaveBeenCalledTimes(1);
    expect(cache.get(SETTLED_KEY)).toBe("rejected");

    await pollOnce();

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(cache.get(CURSOR_KEY)).toBe(EVENT_ID);
  });

  it.each([
    [
      "a 403 app access refusal",
      rejection(403, {
        title: "Client Forbidden",
        detail:
          "When authenticating requests to the Twitter API v2 endpoints, you must use keys and tokens from a Twitter developer App that is attached to a Project.",
        reason: "client-not-enrolled",
        type: "https://api.twitter.com/2/problems/client-forbidden",
      }),
    ],
    ["a 403 without a recipient-level reason", rejection(403)],
    [
      "a 402 credit exhaustion",
      rejection(402, {
        title: "Payment Required",
        detail: "Your account does not have enough credits.",
        status: 402,
      }),
    ],
  ])(
    "reopens the event on %s, so it resumes once the app is fixed",
    async (_case, error) => {
      const send = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ dm_event_id: "301" });
      const { cache, handleMessage, pollOnce, runtime } = createHarness(
        "g",
        send,
      );

      await pollOnce();

      expect(runtime.reportError).toHaveBeenCalledTimes(1);
      expect(cache.has(SETTLED_KEY)).toBe(false);
      expect(cache.get(CURSOR_KEY)).toBe("100");

      await pollOnce();

      expect(handleMessage).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledTimes(2);
      expect(cache.get(SETTLED_KEY)).toBe("delivered:301");
      expect(cache.get(CURSOR_KEY)).toBe(EVENT_ID);
    },
  );
});
