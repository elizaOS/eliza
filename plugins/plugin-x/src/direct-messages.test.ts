/**
 * Unit tests for inbound X DM polling with a deterministic fake API and
 * runtime. The harness verifies the startup watermark, one reply per new
 * event, persistence of inbound/outbound conversation memories, multi-page
 * catch-up before the durable cursor advances, explicit-rejection retries,
 * and at-most-once settlement across ambiguous sends and receipt-store loss.
 * The delivery tests opt into `TWITTER_DM_POLICY=open`; the closing block
 * covers the default fail-closed pairing gate itself (duck-typed
 * PairingService, real core `checkPairingAllowed`).
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientBase } from "./base";
import type { AuthenticatedTwitterSession } from "./client/auth";
import { isGroupDmEvent, TwitterDirectMessageClient } from "./direct-messages";
import type { TwitterClientState } from "./types";

function authenticatedTwitterClient(
  userId: string,
  v2: object,
  isCurrent: () => boolean = () => true,
) {
  const session = {
    client: { v2 },
    profile: {
      userId,
      username: "elizamakesmagic",
      location: "",
    },
    revision: 1,
  } as unknown as AuthenticatedTwitterSession;
  return {
    withAuthenticatedSession: async <T>(
      operation: (active: AuthenticatedTwitterSession) => Promise<T>,
    ): Promise<T> => operation(session),
    isAuthenticatedSessionCurrent: () => isCurrent(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("X DM conversation classification", () => {
  it("recognizes current MessageCreate group IDs without participant_ids", () => {
    expect(
      isGroupDmEvent({
        dm_conversation_id: "1582103724607971328",
        event_type: "MessageCreate",
      }),
    ).toBe(true);
  });

  it("keeps current one-to-one IDs and unknown shapes behind the DM gate", () => {
    expect(isGroupDmEvent({ dm_conversation_id: "42-9001" })).toBe(false);
    expect(isGroupDmEvent({ dm_conversation_id: "unexpected-shape" })).toBe(
      false,
    );
  });
});

describe("TwitterDirectMessageClient", () => {
  it("routes configured DMs to personal Eliza without invoking the public agent", async () => {
    vi.useFakeTimers();
    const listDmEvents = vi.fn(async () => ({
      events: [
        {
          id: "501",
          sender_id: "111",
          dm_conversation_id: "conversation-1",
          text: "what is on my calendar?",
          event_type: "MessageCreate",
        },
      ],
      includes: { users: [{ id: "111", username: "alice", name: "Alice" }] },
    }));
    const sendDmToParticipant = vi.fn(async () => ({
      data: { dm_event_id: "reply-501" },
    }));
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              identity: { id: "personal-agent", runtime: "dedicated" },
              reply: "Your next event is at 2 PM.",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const cache = new Map<string, string>([
      ["twitter/agent/222/dm_cursor", "500"],
    ]);
    const handleMessage = vi.fn();
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      getCache: async (key: string) => cache.get(key),
      setCache: async (key: string, value: string) => {
        cache.set(key, value);
      },
      deleteCache: async (key: string) => cache.delete(key),
      getMemoryById: async () => null,
      createMemory: vi.fn(async () => undefined),
      ensureWorldExists: vi.fn(async () => undefined),
      updateWorld: vi.fn(async () => undefined),
      ensureRoomExists: vi.fn(async () => undefined),
      ensureConnection: vi.fn(async () => undefined),
      messageService: { handleMessage },
      reportError: vi.fn(),
      getSetting: vi.fn((key: string) =>
        key === "TWITTER_BROKER_TOKEN" ? "test-broker-token" : null,
      ),
    } as unknown as IAgentRuntime;
    const client = {
      accountId: "agent",
      profile: { id: "stale-profile", username: "stale-user" },
      twitterClient: authenticatedTwitterClient("222", {
        listDmEvents,
        sendDmToParticipant,
      }),
    } as unknown as ClientBase;
    const dmClient = new TwitterDirectMessageClient(client, runtime, {
      TWITTER_DRY_RUN: "false",
      TWITTER_DM_POLICY: "open",
      TWITTER_DM_POLL_INTERVAL_SECONDS: "15",
      TWITTER_PERSONAL_DM_ROUTER_URL:
        "https://cloud.eliza.app/api/v1/twitter/personal-message",
    });

    await dmClient.start();

    expect(handleMessage).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.eliza.app/api/v1/twitter/personal-message",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer test-broker-token",
        }),
        body: JSON.stringify({
          recipientTwitterUserId: "222",
          senderTwitterUserId: "111",
          senderUsername: "alice",
          displayName: "Alice",
          dmEventId: "501",
          message: "what is on my calendar?",
        }),
      }),
    );
    expect(sendDmToParticipant).toHaveBeenCalledWith("111", {
      text: "Your next event is at 2 PM.",
    });
    expect(cache.get("twitter/agent/222/dm_cursor")).toBe("501");
    await dmClient.stop();
  });

  it("does not send or advance the cursor when credentials rotate during personal routing", async () => {
    vi.useFakeTimers();
    const route = deferred<Response>();
    const fetchMock = vi.fn(() => route.promise);
    vi.stubGlobal("fetch", fetchMock);
    const event = {
      id: "601",
      sender_id: "111",
      dm_conversation_id: "conversation-1",
      text: "private question",
      event_type: "MessageCreate",
    };
    const sendA = vi.fn();
    const sendB = vi.fn();
    const cache = new Map<string, string>([
      ["twitter/agent/account-a/dm_cursor", "600"],
    ]);
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      getCache: async (key: string) => cache.get(key),
      setCache: async (key: string, value: string) => {
        cache.set(key, value);
      },
      deleteCache: async (key: string) => cache.delete(key),
      getMemoryById: async () => null,
      createMemory: vi.fn(async () => undefined),
      ensureWorldExists: vi.fn(async () => undefined),
      updateWorld: vi.fn(async () => undefined),
      ensureRoomExists: vi.fn(async () => undefined),
      ensureConnection: vi.fn(async () => undefined),
      messageService: { handleMessage: vi.fn() },
      reportError: vi.fn(),
      getSetting: vi.fn((key: string) =>
        key === "TWITTER_BROKER_TOKEN" ? "test-broker-token" : null,
      ),
    } as unknown as IAgentRuntime;
    let current = true;
    const client = {
      accountId: "agent",
      profile: { id: "account-b", username: "stale-account-b" },
      twitterClient: authenticatedTwitterClient(
        "account-a",
        {
          listDmEvents: async () => ({ events: [event] }),
          sendDmToParticipant: sendA,
        },
        () => current,
      ),
    } as unknown as ClientBase;
    const dmClient = new TwitterDirectMessageClient(client, runtime, {
      TWITTER_DRY_RUN: "false",
      TWITTER_DM_POLICY: "open",
      TWITTER_DM_POLL_INTERVAL_SECONDS: "15",
      TWITTER_PERSONAL_DM_ROUTER_URL:
        "https://cloud.eliza.app/api/v1/twitter/personal-message",
    });

    const start = dmClient.start();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    current = false;
    route.resolve(
      new Response(
        JSON.stringify({
          success: true,
          data: { reply: "should not cross accounts" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await start;

    expect(sendA).not.toHaveBeenCalled();
    expect(sendB).not.toHaveBeenCalled();
    expect(cache.get("twitter/agent/account-a/dm_cursor")).toBe("600");
    expect(runtime.reportError).toHaveBeenCalledWith(
      "XDirectMessages.poll",
      expect.objectContaining({ code: "X_AUTH_SESSION_ROTATED" }),
      { accountId: "agent" },
    );
    await dmClient.stop();
  });

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
      deleteCache: async (key: string) => cache.delete(key),
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
      twitterClient: authenticatedTwitterClient("agent-user-id", {
        listDmEvents,
        sendDmToParticipant,
      }),
    } as unknown as ClientBase;
    const state = {
      TWITTER_DRY_RUN: "false",
      TWITTER_DM_POLICY: "open",
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
    // Newest-first accumulating paginator: first fetch returns the newest
    // page, fetchNext merges the older page containing the cursor boundary.
    const newestPage = [
      {
        id: "205",
        sender_id: "person-1",
        dm_conversation_id: "conversation-1",
        text: "message five",
        event_type: "MessageCreate",
      },
      {
        id: "204",
        sender_id: "person-1",
        dm_conversation_id: "conversation-1",
        text: "message four",
        event_type: "MessageCreate",
      },
    ];
    const olderPage = [
      {
        id: "203",
        sender_id: "person-1",
        dm_conversation_id: "conversation-1",
        text: "message three",
        event_type: "MessageCreate",
      },
      {
        id: "200",
        sender_id: "person-1",
        dm_conversation_id: "conversation-1",
        text: "already handled",
        event_type: "MessageCreate",
      },
    ];
    const paginator = {
      events: [...newestPage],
      includes: {
        users: [{ id: "person-1", username: "alice", name: "Alice" }],
      },
      done: false,
      fetchNext: vi.fn(async () => {
        paginator.events.push(...olderPage);
        paginator.done = true;
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
      deleteCache: async (key: string) => cache.delete(key),
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
      twitterClient: authenticatedTwitterClient("agent-user-id", {
        listDmEvents,
        sendDmToParticipant,
      }),
    } as unknown as ClientBase;
    const state = {
      TWITTER_DRY_RUN: "false",
      TWITTER_DM_POLICY: "open",
      TWITTER_DM_POLL_INTERVAL_SECONDS: "15",
    } as unknown as TwitterClientState;
    const dmClient = new TwitterDirectMessageClient(client, runtime, state);

    await dmClient.start();
    expect(paginator.fetchNext).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledTimes(3);
    expect(sent).toEqual([
      "echo:message three",
      "echo:message four",
      "echo:message five",
    ]);
    expect(cache.get("twitter/agent/agent-user-id/dm_cursor")).toBe("205");

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
      .mockRejectedValueOnce({ status: 429, message: "rate limited" })
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
      deleteCache: async (key: string) => cache.delete(key),
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
      twitterClient: authenticatedTwitterClient("agent-user-id", {
        listDmEvents,
        sendDmToParticipant,
      }),
    } as unknown as ClientBase;
    const state = {
      TWITTER_DRY_RUN: "false",
      TWITTER_DM_POLICY: "open",
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

  it("paginates beyond twenty pages without advancing past unseen events", async () => {
    vi.useFakeTimers();
    const paginator = {
      events: [
        {
          id: "122",
          sender_id: "person-1",
          dm_conversation_id: "conversation-1",
          text: "message 122",
          event_type: "MessageCreate",
        },
      ],
      includes: {
        users: [{ id: "person-1", username: "alice", name: "Alice" }],
      },
      done: false,
      fetchNext: vi.fn(async () => {
        const oldest = Number(paginator.events.at(-1)?.id ?? "122");
        paginator.events.push({
          id: String(oldest - 1),
          sender_id: "person-1",
          dm_conversation_id: "conversation-1",
          text: `message ${oldest - 1}`,
          event_type: "MessageCreate",
        });
        if (oldest - 1 === 100) paginator.done = true;
        return paginator;
      }),
    };
    const cache = new Map<string, string>([
      ["twitter/agent/agent-user-id/dm_cursor", "100"],
    ]);
    const sendDmToParticipant = vi.fn(async () => ({
      data: { dm_event_id: `reply-${sendDmToParticipant.mock.calls.length}` },
    }));
    const handleMessage = vi.fn(
      async (
        _runtime: IAgentRuntime,
        memory: Memory,
        callback: (response: { text: string }) => Promise<Memory[]>,
      ) => callback({ text: `echo:${memory.content.text}` }),
    );
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      getCache: async (key: string) => cache.get(key),
      setCache: async (key: string, value: string) => {
        cache.set(key, value);
      },
      deleteCache: async (key: string) => cache.delete(key),
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
      twitterClient: authenticatedTwitterClient("agent-user-id", {
        listDmEvents: async () => paginator,
        sendDmToParticipant,
      }),
    } as unknown as ClientBase;
    const dmClient = new TwitterDirectMessageClient(client, runtime, {
      TWITTER_DRY_RUN: "false",
      TWITTER_DM_POLICY: "open",
      TWITTER_DM_POLL_INTERVAL_SECONDS: "15",
    } as unknown as TwitterClientState);

    await dmClient.start();
    expect(paginator.fetchNext).toHaveBeenCalledTimes(22);
    expect(handleMessage).toHaveBeenCalledTimes(22);
    expect(cache.get("twitter/agent/agent-user-id/dm_cursor")).toBe("122");
    await dmClient.stop();
  });

  it("does not duplicate a delivered reply when response-memory persistence fails", async () => {
    vi.useFakeTimers();
    const event = {
      id: "401",
      sender_id: "person-1",
      dm_conversation_id: "conversation-1",
      text: "persist this",
      event_type: "MessageCreate",
    };
    const cache = new Map<string, string>([
      ["twitter/agent/agent-user-id/dm_cursor", "400"],
    ]);
    const memories = new Map<string, Memory>();
    const createMemory = vi.fn(async (memory: Memory) => {
      if (memory.metadata?.fromBot)
        throw new Error("receipt store unavailable");
      if (memory.id) memories.set(memory.id, memory);
    });
    const sendDmToParticipant = vi.fn(async () => ({
      data: { dm_event_id: "reply-401" },
    }));
    const handleMessage = vi.fn(
      async (
        _runtime: IAgentRuntime,
        memory: Memory,
        callback: (response: { text: string }) => Promise<Memory[]>,
      ) => {
        await createMemory(memory);
        await callback({ text: "stored externally" });
      },
    );
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      getCache: async (key: string) => cache.get(key),
      setCache: async (key: string, value: string) => {
        cache.set(key, value);
      },
      deleteCache: async (key: string) => cache.delete(key),
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
      twitterClient: authenticatedTwitterClient("agent-user-id", {
        listDmEvents: async () => ({ events: [event] }),
        sendDmToParticipant,
      }),
    } as unknown as ClientBase;
    const dmClient = new TwitterDirectMessageClient(client, runtime, {
      TWITTER_DRY_RUN: "false",
      TWITTER_DM_POLICY: "open",
      TWITTER_DM_POLL_INTERVAL_SECONDS: "15",
    } as unknown as TwitterClientState);

    const startPromise = dmClient.start();
    await vi.advanceTimersByTimeAsync(3_000);
    await startPromise;
    expect(sendDmToParticipant).toHaveBeenCalledTimes(1);
    expect(runtime.reportError).toHaveBeenCalledWith(
      "XDirectMessages.responseMemory",
      expect.any(Error),
      expect.any(Object),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendDmToParticipant).toHaveBeenCalledTimes(1);
    expect(cache.get("twitter/agent/agent-user-id/dm_cursor")).toBe("401");
    await dmClient.stop();
  });

  it("retains an at-most-once tombstone after an ambiguous transport failure", async () => {
    vi.useFakeTimers();
    const event = {
      id: "501",
      sender_id: "person-1",
      dm_conversation_id: "conversation-1",
      text: "only once",
      event_type: "MessageCreate",
    };
    const cache = new Map<string, string>([
      ["twitter/agent/agent-user-id/dm_cursor", "500"],
    ]);
    const sendDmToParticipant = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket closed after write"))
      .mockResolvedValue({ data: { dm_event_id: "reply-501" } });
    const handleMessage = vi.fn(
      async (
        _runtime: IAgentRuntime,
        _memory: Memory,
        callback: (response: { text: string }) => Promise<Memory[]>,
      ) => callback({ text: "one attempt" }).catch(() => []),
    );
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      getCache: async (key: string) => cache.get(key),
      setCache: async (key: string, value: string) => {
        cache.set(key, value);
      },
      deleteCache: async (key: string) => cache.delete(key),
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
      twitterClient: authenticatedTwitterClient("agent-user-id", {
        listDmEvents: async () => ({ events: [event] }),
        sendDmToParticipant,
      }),
    } as unknown as ClientBase;
    const dmClient = new TwitterDirectMessageClient(client, runtime, {
      TWITTER_DRY_RUN: "false",
      TWITTER_DM_POLICY: "open",
      TWITTER_DM_POLL_INTERVAL_SECONDS: "15",
    } as unknown as TwitterClientState);

    await dmClient.start();
    expect(sendDmToParticipant).toHaveBeenCalledTimes(1);
    expect(cache.get("twitter/agent/agent-user-id/dm_cursor")).toBe("500");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendDmToParticipant).toHaveBeenCalledTimes(1);
    expect(cache.get("twitter/agent/agent-user-id/dm_cursor")).toBe("501");
    await dmClient.stop();
  });

  it("sends exactly one reply when the pipeline invokes the callback repeatedly in one turn", async () => {
    vi.useFakeTimers();
    const event = {
      id: "601",
      sender_id: "person-1",
      dm_conversation_id: "conversation-1",
      text: "say it once",
      event_type: "MessageCreate",
    };
    const cache = new Map<string, string>([
      ["twitter/agent/agent-user-id/dm_cursor", "600"],
    ]);
    const sendDmToParticipant = vi.fn(async () => ({
      data: { dm_event_id: "reply-601" },
    }));
    const callbackResults: Memory[][] = [];
    // Mirrors a multi-callback turn: two replying actions plus an evaluator
    // delivery each invoke the same HandlerCallback sequentially.
    const handleMessage = vi.fn(
      async (
        _runtime: IAgentRuntime,
        _memory: Memory,
        callback: (response: { text: string }) => Promise<Memory[]>,
      ) => {
        callbackResults.push(await callback({ text: "first reply" }));
        callbackResults.push(await callback({ text: "second reply" }));
        callbackResults.push(await callback({ text: "evaluator delivery" }));
      },
    );
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      getCache: async (key: string) => cache.get(key),
      setCache: async (key: string, value: string) => {
        cache.set(key, value);
      },
      deleteCache: async (key: string) => cache.delete(key),
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
      twitterClient: authenticatedTwitterClient("agent-user-id", {
        listDmEvents: async () => ({ events: [event] }),
        sendDmToParticipant,
      }),
    } as unknown as ClientBase;
    const dmClient = new TwitterDirectMessageClient(client, runtime, {
      TWITTER_DRY_RUN: "false",
      TWITTER_DM_POLICY: "open",
      TWITTER_DM_POLL_INTERVAL_SECONDS: "15",
    } as unknown as TwitterClientState);

    await dmClient.start();
    expect(sendDmToParticipant).toHaveBeenCalledTimes(1);
    expect(sendDmToParticipant).toHaveBeenCalledWith("person-1", {
      text: "first reply",
    });
    expect(callbackResults[1]).toEqual([]);
    expect(callbackResults[2]).toEqual([]);
    expect(cache.get("twitter/agent/agent-user-id/dm_cursor")).toBe("601");
    expect(cache.get("twitter/agent/agent-user-id/dm_settled/601")).toBe(
      "delivered:reply-601",
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendDmToParticipant).toHaveBeenCalledTimes(1);
    await dmClient.stop();
  });

  it("sends exactly one reply across concurrent callback invocations", async () => {
    vi.useFakeTimers();
    const event = {
      id: "701",
      sender_id: "person-1",
      dm_conversation_id: "conversation-1",
      text: "race me",
      event_type: "MessageCreate",
    };
    const cache = new Map<string, string>([
      ["twitter/agent/agent-user-id/dm_cursor", "700"],
    ]);
    const sendDmToParticipant = vi.fn(async () => ({
      data: { dm_event_id: "reply-701" },
    }));
    const handleMessage = vi.fn(
      async (
        _runtime: IAgentRuntime,
        _memory: Memory,
        callback: (response: { text: string }) => Promise<Memory[]>,
      ) => {
        await Promise.all([
          callback({ text: "parallel one" }),
          callback({ text: "parallel two" }),
        ]);
      },
    );
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      getCache: async (key: string) => cache.get(key),
      setCache: async (key: string, value: string) => {
        cache.set(key, value);
      },
      deleteCache: async (key: string) => cache.delete(key),
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
      twitterClient: authenticatedTwitterClient("agent-user-id", {
        listDmEvents: async () => ({ events: [event] }),
        sendDmToParticipant,
      }),
    } as unknown as ClientBase;
    const dmClient = new TwitterDirectMessageClient(client, runtime, {
      TWITTER_DRY_RUN: "false",
      TWITTER_DM_POLICY: "open",
      TWITTER_DM_POLL_INTERVAL_SECONDS: "15",
    } as unknown as TwitterClientState);

    await dmClient.start();
    expect(sendDmToParticipant).toHaveBeenCalledTimes(1);
    expect(cache.get("twitter/agent/agent-user-id/dm_cursor")).toBe("701");
    await dmClient.stop();
  });

  it("keeps later same-turn invocations suppressed after an explicit rejection and retries next poll", async () => {
    vi.useFakeTimers();
    const event = {
      id: "801",
      sender_id: "person-1",
      dm_conversation_id: "conversation-1",
      text: "reject then retry",
      event_type: "MessageCreate",
    };
    const cache = new Map<string, string>([
      ["twitter/agent/agent-user-id/dm_cursor", "800"],
    ]);
    const sendDmToParticipant = vi
      .fn()
      .mockRejectedValueOnce({ status: 403, message: "forbidden" })
      .mockResolvedValue({ data: { dm_event_id: "reply-801" } });
    // An explicit rejection reopens the event for the NEXT poll; a second
    // callback invocation inside the same turn must still not send.
    const handleMessage = vi.fn(
      async (
        _runtime: IAgentRuntime,
        _memory: Memory,
        callback: (response: { text: string }) => Promise<Memory[]>,
      ) => {
        await callback({ text: "rejected attempt" }).catch(() => []);
        await callback({ text: "same-turn retry" }).catch(() => []);
      },
    );
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      getCache: async (key: string) => cache.get(key),
      setCache: async (key: string, value: string) => {
        cache.set(key, value);
      },
      deleteCache: async (key: string) => cache.delete(key),
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
      twitterClient: authenticatedTwitterClient("agent-user-id", {
        listDmEvents: async () => ({ events: [event] }),
        sendDmToParticipant,
      }),
    } as unknown as ClientBase;
    const dmClient = new TwitterDirectMessageClient(client, runtime, {
      TWITTER_DRY_RUN: "false",
      TWITTER_DM_POLICY: "open",
      TWITTER_DM_POLL_INTERVAL_SECONDS: "15",
    } as unknown as TwitterClientState);

    await dmClient.start();
    expect(sendDmToParticipant).toHaveBeenCalledTimes(1);
    expect(cache.get("twitter/agent/agent-user-id/dm_cursor")).toBe("800");
    expect(
      cache.get("twitter/agent/agent-user-id/dm_settled/801"),
    ).toBeUndefined();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendDmToParticipant).toHaveBeenCalledTimes(2);
    expect(cache.get("twitter/agent/agent-user-id/dm_cursor")).toBe("801");
    expect(cache.get("twitter/agent/agent-user-id/dm_settled/801")).toBe(
      "delivered:reply-801",
    );
    await dmClient.stop();
  });
});

describe("TwitterDirectMessageClient DM access gate (TWITTER_DM_POLICY)", () => {
  function gateHarness(options: {
    policy?: string;
    pairingAllowed?: boolean;
    participantIds?: string[];
  }) {
    const event = {
      id: "901",
      sender_id: "person-1",
      dm_conversation_id: "conversation-1",
      text: "hello agent",
      event_type: "MessageCreate",
      ...(options.participantIds
        ? { participant_ids: options.participantIds }
        : {}),
    };
    const cache = new Map<string, string>([
      ["twitter/agent/agent-user-id/dm_cursor", "900"],
    ]);
    const sendDmToParticipant = vi.fn(async () => ({
      data: { dm_event_id: "reply-901" },
    }));
    const handleMessage = vi.fn(
      async (
        _runtime: IAgentRuntime,
        memory: Memory,
        callback: (response: { text: string }) => Promise<Memory[]>,
      ) => callback({ text: `echo:${memory.content.text}` }),
    );
    const createMemory = vi.fn(async () => undefined);
    const pairingService = {
      isAllowed: vi.fn(async () => options.pairingAllowed ?? false),
      upsertRequest: vi.fn(async () => ({ code: "PAIRCODE1", created: true })),
      claimPairingReply: vi.fn(() => true),
    };
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      getCache: async (key: string) => cache.get(key),
      setCache: async (key: string, value: string) => {
        cache.set(key, value);
      },
      deleteCache: async (key: string) => cache.delete(key),
      getMemoryById: async () => null,
      createMemory,
      ensureWorldExists: vi.fn(async () => undefined),
      updateWorld: vi.fn(async () => undefined),
      ensureRoomExists: vi.fn(async () => undefined),
      ensureConnection: vi.fn(async () => undefined),
      messageService: { handleMessage },
      reportError: vi.fn(),
      getSetting: vi.fn(() => null),
      getService: vi.fn(() => pairingService),
    } as unknown as IAgentRuntime;
    const client = {
      accountId: "agent",
      profile: { id: "agent-user-id", username: "elizamakesmagic" },
      twitterClient: authenticatedTwitterClient("agent-user-id", {
        listDmEvents: async () => ({ events: [event] }),
        sendDmToParticipant,
      }),
    } as unknown as ClientBase;
    const state = {
      TWITTER_DRY_RUN: "false",
      TWITTER_DM_POLL_INTERVAL_SECONDS: "15",
      ...(options.policy ? { TWITTER_DM_POLICY: options.policy } : {}),
    } as unknown as TwitterClientState;
    return {
      dmClient: new TwitterDirectMessageClient(client, runtime, state),
      cache,
      createMemory,
      handleMessage,
      pairingService,
      sendDmToParticipant,
    };
  }

  it("blocks an unpaired sender by default, DMs the pairing code, and still advances the cursor", async () => {
    vi.useFakeTimers();
    const {
      dmClient,
      cache,
      createMemory,
      handleMessage,
      pairingService,
      sendDmToParticipant,
    } = gateHarness({});

    await dmClient.start();

    expect(handleMessage).not.toHaveBeenCalled();
    expect(createMemory).not.toHaveBeenCalled();
    expect(pairingService.upsertRequest).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "x", senderId: "person-1" }),
    );
    expect(sendDmToParticipant).toHaveBeenCalledTimes(1);
    expect(sendDmToParticipant.mock.calls[0][0]).toBe("person-1");
    expect(sendDmToParticipant.mock.calls[0][1].text).toContain(
      "Pairing code: PAIRCODE1",
    );
    expect(cache.get("twitter/agent/agent-user-id/dm_cursor")).toBe("901");
    await dmClient.stop();
  });

  it("routes a pairing-approved sender into the agent message loop", async () => {
    vi.useFakeTimers();
    const { dmClient, handleMessage, sendDmToParticipant } = gateHarness({
      pairingAllowed: true,
    });

    await dmClient.start();

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(sendDmToParticipant).toHaveBeenCalledWith("person-1", {
      text: "echo:hello agent",
    });
    await dmClient.stop();
  });

  it("fails closed on an unrecognized TWITTER_DM_POLICY value", async () => {
    vi.useFakeTimers();
    const { dmClient, handleMessage, pairingService } = gateHarness({
      policy: "opne",
    });

    await dmClient.start();

    expect(handleMessage).not.toHaveBeenCalled();
    expect(pairingService.upsertRequest).toHaveBeenCalled();
    await dmClient.stop();
  });

  it("blocks without a pairing reply under TWITTER_DM_POLICY=disabled", async () => {
    vi.useFakeTimers();
    const { dmClient, handleMessage, pairingService, sendDmToParticipant } =
      gateHarness({ policy: "disabled" });

    await dmClient.start();

    expect(handleMessage).not.toHaveBeenCalled();
    expect(pairingService.isAllowed).not.toHaveBeenCalled();
    expect(sendDmToParticipant).not.toHaveBeenCalled();
    await dmClient.stop();
  });

  it("does not gate senders inside a group conversation", async () => {
    vi.useFakeTimers();
    const { dmClient, handleMessage, pairingService } = gateHarness({
      participantIds: ["agent-user-id", "person-1", "person-2"],
    });

    await dmClient.start();

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(pairingService.isAllowed).not.toHaveBeenCalled();
    await dmClient.stop();
  });
});
