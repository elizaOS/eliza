/**
 * Behaviour proof for the `mode: "tool"` streaming modification: an inline
 * tool-call step merged onto the in-flight assistant turn's `toolEvents` by
 * `callId`, leaving `text` untouched. Drives the real reducer seam
 * (`applyStreamingTextModification`) the chat SSE `onToolEvent` callback uses.
 */

import { describe, expect, it } from "vitest";

import type { ConversationMessage } from "../api";
import { applyStreamingTextModification } from "./useStreamingText";

function collect(initial: ConversationMessage[]) {
  let state = initial;
  const setter = (
    updater:
      | ConversationMessage[]
      | ((prev: ConversationMessage[]) => ConversationMessage[]),
  ) => {
    state = typeof updater === "function" ? updater(state) : updater;
  };
  return {
    apply: (mod: Parameters<typeof applyStreamingTextModification>[1]) =>
      applyStreamingTextModification(setter, mod),
    get: () => state,
  };
}

const assistant: ConversationMessage = {
  id: "m1",
  role: "assistant",
  text: "on it",
  timestamp: 0,
};

describe("applyStreamingTextModification mode:tool", () => {
  it("appends a running tool row without touching text", () => {
    const store = collect([assistant]);
    store.apply({
      messageId: "m1",
      mode: "tool",
      event: { phase: "call", callId: "c1", toolName: "WEB_SEARCH" },
    });
    const msg = store.get()[0];
    expect(msg.text).toBe("on it");
    expect(msg.toolEvents).toHaveLength(1);
    expect(msg.toolEvents?.[0]).toMatchObject({
      callId: "c1",
      status: "running",
      type: "tool_call",
    });
  });

  it("flips the same row to completed on a result frame", () => {
    const store = collect([assistant]);
    store.apply({
      messageId: "m1",
      mode: "tool",
      event: { phase: "call", callId: "c1", toolName: "WEB_SEARCH" },
    });
    store.apply({
      messageId: "m1",
      mode: "tool",
      event: {
        phase: "result",
        callId: "c1",
        toolName: "WEB_SEARCH",
        result: { hits: 2 },
      },
    });
    const msg = store.get()[0];
    expect(msg.toolEvents).toHaveLength(1);
    expect(msg.toolEvents?.[0]).toMatchObject({
      status: "completed",
      type: "tool_result",
      result: { hits: 2 },
    });
  });

  it("no-ops for an unknown message id (referential equality preserved)", () => {
    const initial = [assistant];
    const store = collect(initial);
    store.apply({
      messageId: "does-not-exist",
      mode: "tool",
      event: { phase: "call", callId: "c1", toolName: "X" },
    });
    expect(store.get()).toBe(initial);
  });
});
