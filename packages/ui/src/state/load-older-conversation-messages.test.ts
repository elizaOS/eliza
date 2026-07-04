/**
 * Unit tests for `loadOlderConversationMessages` — the pure orchestration of one
 * older-page fetch for the infinite upward scroll (#13532). Verifies the cursor
 * derivation (oldest held message's timestamp), the renderable filter, the
 * prepend call, and the hasMore contract (empty page ⇒ false regardless of the
 * server flag). No React.
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

/** An assistant turn with no text / blocks / media — filtered out of the transcript. */
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

describe("loadOlderConversationMessages (#13532)", () => {
  it("uses the oldest held message's timestamp as the before cursor", async () => {
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

  it("prepends the fetched older page (renderable turns only) and reports hasMore", async () => {
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
    // The blank action-log assistant turn is filtered out.
    expect(prependMessages).toHaveBeenCalledTimes(1);
    expect(
      prependMessages.mock.calls[0][0].map((m: ConversationMessage) => m.id),
    ).toEqual(["a", "b"]);
    expect(result.hasMore).toBe(true);
    expect(result.prependedCount).toBe(2);
  });

  it("returns hasMore=false and does not prepend when there is nothing older", async () => {
    const prependMessages = vi.fn();
    const { client } = makeClient({ messages: [], hasMore: false });
    const result = await loadOlderConversationMessages({
      client,
      conversationId: "conv-1",
      currentMessages: [userMsg("c", 20)],
      prependMessages,
    });
    expect(prependMessages).not.toHaveBeenCalled();
    expect(result.hasMore).toBe(false);
    expect(result.prependedCount).toBe(0);
  });

  it("treats an empty page as the true top even if the server said hasMore=true", async () => {
    const { client } = makeClient({ messages: [], hasMore: true });
    const result = await loadOlderConversationMessages({
      client,
      conversationId: "conv-1",
      currentMessages: [userMsg("c", 20)],
      prependMessages: () => {},
    });
    expect(result.hasMore).toBe(false);
  });

  it("does nothing (hasMore=false) when the current thread is empty (no cursor)", async () => {
    const { client, calls } = makeClient({ messages: [], hasMore: true });
    const result = await loadOlderConversationMessages({
      client,
      conversationId: "conv-1",
      currentMessages: [],
      prependMessages: () => {},
    });
    // No fetch is issued without an anchor.
    expect(calls).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  it("propagates a fetch rejection so the caller's in-flight guard can re-arm", async () => {
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
