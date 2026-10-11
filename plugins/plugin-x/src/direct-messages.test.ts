/**
 * DM auto-reply egress: a reply longer than X's per-message DM limit must go
 * out as ordered parts, and a failure after an accepted part must keep the
 * no-replay marker. The harness runs the real `TwitterDirectMessageClient`
 * poll against an in-memory cache and a recorded DM transport.
 */
import {
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

function createHarness(
  reply: string,
  sendDmToParticipant: ReturnType<typeof vi.fn>,
) {
  const cache = new Map<string, unknown>([[CURSOR_KEY, "100"]]);
  const createMemory = vi.fn(async (_memory: Memory) => undefined);
  const handleMessage = vi.fn(
    async (
      _runtime: IAgentRuntime,
      _message: Memory,
      callback: HandlerCallback,
    ) => {
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
            dm_conversation_id: `${SENDER_ID}-${OWN_USER_ID}`,
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
      sendDmInConversation: vi.fn(),
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
  return { cache, createMemory, handleMessage, pollOnce, runtime };
}

function rejection(status: number): Error {
  return Object.assign(new Error(`Request failed with code ${status}`), {
    code: status,
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

  it("keeps a reply within the limit as one request", async () => {
    const reply = "c".repeat(X_MAX_DM_LENGTH);
    const send = vi.fn(async () => ({ dm_event_id: "301" }));
    const { cache, pollOnce } = createHarness(reply, send);

    await pollOnce();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(SENDER_ID, { text: reply });
    expect(cache.get(SETTLED_KEY)).toBe("delivered:301");
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

  it("reopens the event when the first part is rejected", async () => {
    const reply = "e".repeat(X_MAX_DM_LENGTH + 5);
    const send = vi.fn().mockRejectedValueOnce(rejection(400));
    const { cache, pollOnce, runtime } = createHarness(reply, send);

    await pollOnce();

    expect(send).toHaveBeenCalledTimes(1);
    expect(runtime.reportError).toHaveBeenCalledTimes(1);
    expect(cache.has(SETTLED_KEY)).toBe(false);
    expect(cache.get(CURSOR_KEY)).toBe("100");
  });
});
