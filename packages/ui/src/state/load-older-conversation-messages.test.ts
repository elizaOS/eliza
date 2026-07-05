/**
 * Unit coverage for the pure load-older orchestration used by the chat
 * transcript's upward infinite scroll.
 */
import { describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../api";
import {
  type LoadOlderClient,
  loadOlderConversationMessages,
} from "./load-older-conversation-messages";

function userMsg(id: string, timestamp: number): ConversationMessage {
  return { id, role: "user", text: `m-${id}`, timestamp };
}

function blankAssistant(id: string, timestamp: number): ConversationMessage {
  return { id, role: "assistant", text: "   ", timestamp };
}

function makeClient(response: {
  messages: ConversationMessage[];
  hasMore?: boolean;
}): {
  client: LoadOlderClient;
  calls: Array<{ id: string; options?: unknown }>;
} {
  const calls: Array<{ id: string; options?: unknown }> = [];
  const client: LoadOlderClient = {
    getConversationMessages: vi.fn(async (id, options) => {
      calls.push({ id, options });
      return response;
    }),
  };
  return { client, calls };
}

describe("loadOlderConversationMessages", () => {
  it("uses the oldest held message timestamp as the before cursor", async () => {
    const { client, calls } = makeClient({
      messages: [userMsg("a", 10)],
      hasMore: true,
    });

    await loadOlderConversationMessages({
      client,
      conversationId: "conv-1",
      currentMessages: [userMsg("b", 20), userMsg("c", 30)],
      prependMessages: () => {},
      limit: 50,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe("conv-1");
    expect(calls[0].options).toMatchObject({ before: 20, limit: 50 });
  });

  it("prepends renderable older turns and reports hasMore", async () => {
    const prependMessages = vi.fn();
    const { client } = makeClient({
      messages: [userMsg("a", 10), blankAssistant("log", 12), userMsg("b", 15)],
      hasMore: true,
    });

    const result = await loadOlderConversationMessages({
      client,
      conversationId: "conv-1",
      currentMessages: [userMsg("c", 20)],
      prependMessages,
    });

    expect(prependMessages).toHaveBeenCalledTimes(1);
    expect(
      prependMessages.mock.calls[0][0].map((m: ConversationMessage) => m.id),
    ).toEqual(["a", "b"]);
    expect(result).toEqual({ hasMore: true, prependedCount: 2 });
  });

  it("returns hasMore=false and does not prepend on an empty older page", async () => {
    const prependMessages = vi.fn();
    const { client } = makeClient({ messages: [], hasMore: true });

    const result = await loadOlderConversationMessages({
      client,
      conversationId: "conv-1",
      currentMessages: [userMsg("c", 20)],
      prependMessages,
    });

    expect(prependMessages).not.toHaveBeenCalled();
    expect(result).toEqual({ hasMore: false, prependedCount: 0 });
  });

  it("does not fetch when the current thread has no cursor", async () => {
    const { client, calls } = makeClient({ messages: [], hasMore: true });

    const result = await loadOlderConversationMessages({
      client,
      conversationId: "conv-1",
      currentMessages: [],
      prependMessages: () => {},
    });

    expect(calls).toHaveLength(0);
    expect(result).toEqual({ hasMore: false, prependedCount: 0 });
  });

  it("advances the cursor past a fully-non-renderable page instead of refetching it", async () => {
    // Page 1 (before=100): a run of silent assistant turns — filters to nothing.
    // The retained-oldest cursor alone would refetch this exact page forever;
    // the in-invocation hop must advance below it and prepend page 2.
    const prependMessages = vi.fn();
    const calls: Array<{ before?: number }> = [];
    const client: LoadOlderClient = {
      getConversationMessages: vi.fn(async (_id, options) => {
        calls.push({ before: options?.before });
        if (options?.before === 100) {
          return {
            messages: [blankAssistant("s1", 60), blankAssistant("s2", 70)],
            hasMore: true,
          };
        }
        return {
          messages: [userMsg("a", 40), userMsg("b", 50)],
          hasMore: false,
        };
      }),
    };

    const result = await loadOlderConversationMessages({
      client,
      conversationId: "conv-1",
      currentMessages: [userMsg("c", 100)],
      prependMessages,
    });

    expect(calls.map((c) => c.before)).toEqual([100, 60]);
    expect(
      prependMessages.mock.calls[0][0].map((m: ConversationMessage) => m.id),
    ).toEqual(["a", "b"]);
    expect(result).toEqual({ hasMore: false, prependedCount: 2 });
  });

  it("stops at the hop budget on a long filtered run but keeps hasMore armed", async () => {
    const prependMessages = vi.fn();
    let call = 0;
    const client: LoadOlderClient = {
      getConversationMessages: vi.fn(async () => {
        call += 1;
        return {
          messages: [blankAssistant(`s-${call}`, 1000 - call * 10)],
          hasMore: true,
        };
      }),
    };

    const result = await loadOlderConversationMessages({
      client,
      conversationId: "conv-1",
      currentMessages: [userMsg("c", 2000)],
      prependMessages,
    });

    expect(call).toBe(5);
    expect(prependMessages).not.toHaveBeenCalled();
    expect(result).toEqual({ hasMore: true, prependedCount: 0 });
  });

  it("propagates fetch failures so the caller can retry", async () => {
    const client: LoadOlderClient = {
      getConversationMessages: vi.fn(async () => {
        throw new Error("network");
      }),
    };

    await expect(
      loadOlderConversationMessages({
        client,
        conversationId: "conv-1",
        currentMessages: [userMsg("c", 20)],
        prependMessages: () => {},
      }),
    ).rejects.toThrow("network");
  });
});
