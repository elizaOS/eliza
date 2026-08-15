/**
 * Unit tests for inbound X DM polling with a deterministic fake API and
 * runtime. The harness verifies the startup watermark, one reply per new
 * event, and persistence of inbound/outbound conversation memories.
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
});
