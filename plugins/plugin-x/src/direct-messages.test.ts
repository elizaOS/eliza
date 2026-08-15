/**
 * Unit tests for inbound X DM polling with a deterministic fake API and
 * runtime. The harness verifies the startup watermark, one reply per new
 * event, persistence of inbound/outbound conversation memories, multi-page
 * catch-up before the durable cursor advances, and retry of replies whose
 * send failed transiently.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientBase } from "./base";
import { TwitterDirectMessageClient } from "./direct-messages";
import type { TwitterClientState } from "./types";

afterEach(() => {
  vi.useRealTimers();
});

describe("TwitterDirectMessageClient", () => {
  it("watermarks history, then handles and replies to each new DM once", async () => {
    vi.useFakeTimers();
    const pages = [
      {
        events: [
          {
            id: "100",
            sender_id: "person-1",
            dm_conversation_id: "conversation-1",
            text: "old message",
            event_type: "MessageCreate",
          },
        ],
      },
      {
        events: [
          {
            id: "100",
            sender_id: "person-1",
            dm_conversation_id: "conversation-1",
            text: "old message",
            event_type: "MessageCreate",
          },
          {
            id: "101",
            sender_id: "person-1",
            dm_conversation_id: "conversation-1",
            text: "hello eliza",
            created_at: "2026-08-13T12:00:00.000Z",
            event_type: "MessageCreate",
          },
        ],
        includes: {
          users: [{ id: "person-1", username: "alice", name: "Alice" }],
        },
      },
      {
        events: [
          {
            id: "101",
            sender_id: "person-1",
            dm_conversation_id: "conversation-1",
            text: "hello eliza",
            event_type: "MessageCreate",
          },
        ],
      },
    ];
    const listDmEvents = vi.fn(async () => pages.shift() ?? { events: [] });
    const sendDmToParticipant = vi.fn(async () => ({
      data: { dm_event_id: "reply-101" },
    }));
    const cache = new Map<string, string>();
    const memories = new Map<string, Memory>();
    const createMemory = vi.fn(async (memory: Memory) => {
      if (memory.id) memories.set(memory.id, memory);
    });
    const handleMessage = vi.fn(
      async (
        _runtime: IAgentRuntime,
        memory: Memory,
        callback: (response: { text: string }) => Promise<Memory[]>,
      ) => {
        await createMemory(memory);
        await callback({ text: "Hi Alice" });
      },
    );
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      getCache: async (key: string) => cache.get(key),
      setCache: async (key: string, value: string) => {
        cache.set(key, value);
      },
      getMemoryById: async (id: string) => memories.get(id) ?? null,
      createMemory,
      ensureWorldExists: vi.fn(async () => undefined),
      updateWorld: vi.fn(async () => undefined),
      ensureRoomExists: vi.fn(async () => undefined),
      ensureConnection: vi.fn(async () => undefined),
      messageService: { handleMessage },
      reportError: vi.fn(),
      getSetting: vi.fn(() => null),
    } as unknown as IAgentRuntime;
    const client = {
      accountId: "agent",
      profile: { id: "agent-user-id", username: "elizamakesmagic" },
      twitterClient: {
        getV2Client: async () => ({
          v2: { listDmEvents, sendDmToParticipant },
        }),
      },
    } as unknown as ClientBase;
    const state = {
      TWITTER_DRY_RUN: "false",
      TWITTER_DM_POLL_INTERVAL_SECONDS: "15",
    } as unknown as TwitterClientState;
    const dmClient = new TwitterDirectMessageClient(client, runtime, state);

    await dmClient.start();
    expect(handleMessage).not.toHaveBeenCalled();
    expect([...cache.values()]).toContain("100");

    await vi.advanceTimersByTimeAsync(15_000);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    const connection = vi.mocked(runtime.ensureConnection).mock.calls[0]?.[0];
    expect(connection?.entityId).toBe(connection?.userId);
    expect(connection?.userId).not.toBe("person-1");
    const world = vi.mocked(runtime.ensureWorldExists).mock.calls[0]?.[0];
    expect(world?.id).toBe(connection?.worldId);
    expect(world?.metadata?.ownership?.ownerId).toBe(connection?.entityId);
    expect(world?.metadata?.ownership?.ownerId).not.toBe("person-1");
    expect(sendDmToParticipant).toHaveBeenCalledWith("person-1", {
      text: "Hi Alice",
    });
    expect([...cache.values()]).toContain("101");
    expect(createMemory).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(sendDmToParticipant).toHaveBeenCalledTimes(1);

    await dmClient.stop();
  });

  it("pages through the DM timeline until the cursor before replying", async () => {
    vi.useFakeTimers();
    // Use more than the former 20-page safety bound. Every page must be
    // collected before the cursor advances or messages 201-203 are lost.
    const event = (id: number) => ({
      id: String(id),
      sender_id: "person-1",
      dm_conversation_id: "conversation-1",
      text: `message ${id}`,
      event_type: "MessageCreate",
    });
    let nextId = 221;
    const paginator = {
      events: [event(222)],
      includes: {
        users: [{ id: "person-1", username: "alice", name: "Alice" }],
      },
      done: false,
      fetchNext: vi.fn(async () => {
        paginator.events.push(event(nextId));
        if (nextId === 200) paginator.done = true;
        nextId -= 1;
        return paginator;
      }),
    };
    const listDmEvents = vi.fn(async () => paginator);
    const sent: string[] = [];
    const sendDmToParticipant = vi.fn(
      async (_id: string, body: { text: string }) => {
        sent.push(body.text);
        return { data: { dm_event_id: `reply-${sent.length}` } };
      },
    );
    const cache = new Map<string, string>();
    cache.set("twitter/agent/agent-user-id/dm_cursor", "200");
    const handleMessage = vi.fn(
      async (
        _runtime: IAgentRuntime,
        memory: Memory,
        callback: (response: { text: string }) => Promise<Memory[]>,
      ) => {
        await callback({ text: `echo:${memory.content.text}` });
      },
    );
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      getCache: async (key: string) => cache.get(key),
      setCache: async (key: string, value: string) => {
        cache.set(key, value);
      },
      getMemoryById: async () => null,
      createMemory: vi.fn(async () => undefined),
      ensureWorldExists: vi.fn(async () => undefined),
      updateWorld: vi.fn(async () => undefined),
      ensureRoomExists: vi.fn(async () => undefined),
      ensureConnection: vi.fn(async () => undefined),
      messageService: { handleMessage },
      reportError: vi.fn(),
      getSetting: vi.fn(() => null),
    } as unknown as IAgentRuntime;
    const client = {
      accountId: "agent",
      profile: { id: "agent-user-id", username: "elizamakesmagic" },
      twitterClient: {
        getV2Client: async () => ({
          v2: { listDmEvents, sendDmToParticipant },
        }),
      },
    } as unknown as ClientBase;
    const state = {
      TWITTER_DRY_RUN: "false",
      TWITTER_DM_POLL_INTERVAL_SECONDS: "15",
    } as unknown as TwitterClientState;
    const dmClient = new TwitterDirectMessageClient(client, runtime, state);

    await dmClient.start();
    expect(paginator.fetchNext).toHaveBeenCalledTimes(22);
    expect(handleMessage).toHaveBeenCalledTimes(22);
    expect(sent).toHaveLength(22);
    expect(sent[0]).toBe("echo:message 201");
    expect(sent[21]).toBe("echo:message 222");
    expect(cache.get("twitter/agent/agent-user-id/dm_cursor")).toBe("222");

    await dmClient.stop();
  });

  it("retries a reply whose send failed instead of deduplicating it forever", async () => {
    vi.useFakeTimers();
    const event = {
      id: "301",
      sender_id: "person-1",
      dm_conversation_id: "conversation-1",
      text: "hello again",
      event_type: "MessageCreate",
    };
    const listDmEvents = vi.fn(async () => ({ events: [event] }));
    const sendDmToParticipant = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("X send temporarily unavailable"), {
          code: 503,
        }),
      )
      .mockResolvedValue({ data: { dm_event_id: "reply-301" } });
    const cache = new Map<string, string>();
    cache.set("twitter/agent/agent-user-id/dm_cursor", "300");
    const memories = new Map<string, Memory>();
    const createMemory = vi.fn(async (memory: Memory) => {
      if (memory.id) memories.set(memory.id, memory);
    });
    // The message service persists the inbound memory before the reply is
    // attempted and swallows callback rejections, mirroring the production
    // shape that previously caused permanent deduplication of failed sends.
    const handleMessage = vi.fn(
      async (
        _runtime: IAgentRuntime,
        memory: Memory,
        callback: (response: { text: string }) => Promise<Memory[]>,
      ) => {
        await createMemory(memory);
        await callback({ text: "Hi again" }).catch(() => []);
      },
    );
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      getCache: async (key: string) => cache.get(key),
      setCache: async (key: string, value: string) => {
        cache.set(key, value);
      },
      getMemoryById: async (id: string) => memories.get(id) ?? null,
      createMemory,
      ensureWorldExists: vi.fn(async () => undefined),
      updateWorld: vi.fn(async () => undefined),
      ensureRoomExists: vi.fn(async () => undefined),
      ensureConnection: vi.fn(async () => undefined),
      messageService: { handleMessage },
      reportError: vi.fn(),
      getSetting: vi.fn(() => null),
    } as unknown as IAgentRuntime;
    const client = {
      accountId: "agent",
      profile: { id: "agent-user-id", username: "elizamakesmagic" },
      twitterClient: {
        getV2Client: async () => ({
          v2: { listDmEvents, sendDmToParticipant },
        }),
      },
    } as unknown as ClientBase;
    const state = {
      TWITTER_DRY_RUN: "false",
      TWITTER_DM_POLL_INTERVAL_SECONDS: "15",
    } as unknown as TwitterClientState;
    const dmClient = new TwitterDirectMessageClient(client, runtime, state);

    // First poll: send fails; the failure is reported, the cursor does not
    // advance, and no delivery settlement is recorded.
    await dmClient.start();
    expect(sendDmToParticipant).toHaveBeenCalledTimes(1);
    expect(runtime.reportError).toHaveBeenCalledTimes(1);
    expect(cache.get("twitter/agent/agent-user-id/dm_cursor")).toBe("300");

    // Second poll: the same event is retried and now delivers.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendDmToParticipant).toHaveBeenCalledTimes(2);
    expect(cache.get("twitter/agent/agent-user-id/dm_cursor")).toBe("301");

    // Third poll: settled — no further sends.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendDmToParticipant).toHaveBeenCalledTimes(2);
    expect(handleMessage).toHaveBeenCalledTimes(2);

    await dmClient.stop();
  });

  it("does not resend when a transport failure has unknown provider acceptance", async () => {
    vi.useFakeTimers();
    const event = {
      id: "401",
      sender_id: "person-1",
      dm_conversation_id: "conversation-1",
      text: "did that send?",
      event_type: "MessageCreate",
    };
    const sendDmToParticipant = vi.fn(async () => {
      throw new Error("socket closed before the response");
    });
    const cache = new Map<string, string>([
      ["twitter/agent/agent-user-id/dm_cursor", "400"],
    ]);
    const reportError = vi.fn();
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      getCache: async (key: string) => cache.get(key),
      setCache: async (key: string, value: string) => {
        cache.set(key, value);
      },
      getMemoryById: async () => null,
      createMemory: vi.fn(async () => undefined),
      ensureWorldExists: vi.fn(async () => undefined),
      updateWorld: vi.fn(async () => undefined),
      ensureRoomExists: vi.fn(async () => undefined),
      ensureConnection: vi.fn(async () => undefined),
      messageService: {
        handleMessage: async (
          _runtime: IAgentRuntime,
          _memory: Memory,
          callback: (response: { text: string }) => Promise<Memory[]>,
        ) => {
          await callback({ text: "Possibly delivered" }).catch(() => []);
        },
      },
      reportError,
      getSetting: vi.fn(() => null),
    } as unknown as IAgentRuntime;
    const client = {
      accountId: "agent",
      profile: { id: "agent-user-id", username: "elizamakesmagic" },
      twitterClient: {
        getV2Client: async () => ({
          v2: {
            listDmEvents: async () => ({ events: [event] }),
            sendDmToParticipant,
          },
        }),
      },
    } as unknown as ClientBase;
    const dmClient = new TwitterDirectMessageClient(client, runtime, {
      TWITTER_DRY_RUN: "false",
      TWITTER_DM_POLL_INTERVAL_SECONDS: "15",
    } as unknown as TwitterClientState);

    await dmClient.start();
    expect(sendDmToParticipant).toHaveBeenCalledTimes(1);
    expect(cache.get("twitter/agent/agent-user-id/dm_cursor")).toBe("401");
    expect(cache.get("twitter/agent/agent-user-id/dm_settled/401")).toBe(
      "unknown_acceptance",
    );
    expect(reportError).toHaveBeenCalledWith(
      "XDirectMessages.deliveryAcceptanceUnknown",
      expect.any(Error),
      expect.objectContaining({ eventId: "401" }),
    );

    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendDmToParticipant).toHaveBeenCalledTimes(1);
    await dmClient.stop();
  });
});
