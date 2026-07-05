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
