/**
 * Behaviour proof for the `provisional` marker on streaming-text
 * modifications: action-callback text is stamped provisional on the in-flight
 * assistant turn (voice output holds it — the double-speak fix), the latest
 * frame is authoritative (a non-provisional frame clears it), and terminal
 * reconciliation always clears it. Drives the real reducer seam
 * (`applyStreamingTextModification`) deterministically; no mocks.
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

function assistant(text = ""): ConversationMessage {
  return { id: "m1", role: "assistant", text, timestamp: 0 };
}

describe("applyStreamingTextModification provisional marker", () => {
  it("stamps provisional on a replace snapshot (action callback ack)", () => {
    const store = collect([assistant()]);
    store.apply({
      messageId: "m1",
      mode: "replace",
      fullText: "Set tone=warm for you.",
      provisional: true,
    });
    const msg = store.get()[0];
    expect(msg.text).toBe("Set tone=warm for you.");
    expect(msg.provisional).toBe(true);
  });

  it("clears provisional when a non-provisional replace supersedes the ack", () => {
    const store = collect([assistant()]);
    store.apply({
      messageId: "m1",
      mode: "replace",
      fullText: "Set tone=warm for you.",
      provisional: true,
    });
    // The reply handler's delivery replaces the ack — the latest frame wins.
    store.apply({
      messageId: "m1",
      mode: "replace",
      fullText: "okay i changed personality to warm",
      provisional: false,
    });
    const msg = store.get()[0];
    expect(msg.text).toBe("okay i changed personality to warm");
    expect(msg.provisional).toBeUndefined();
  });

  it("stamps provisional on an append delta (append-mode callback)", () => {
    const store = collect([assistant("streamed prefix. ")]);
    store.apply({
      messageId: "m1",
      mode: "append",
      token: "Working on it.",
      provisional: true,
    });
    const msg = store.get()[0];
    expect(msg.text).toBe("streamed prefix. Working on it.");
    expect(msg.provisional).toBe(true);
  });

  it("terminal complete clears provisional even when the text is unchanged", () => {
    const store = collect([assistant()]);
    store.apply({
      messageId: "m1",
      mode: "replace",
      fullText: "You have two cloud apps.",
      provisional: true,
    });
    // turnComplete-style action: the ack IS the final message. The complete
    // frame confirms the same text — provisional must still clear so voice
    // can speak it (exactly once).
    store.apply({
      messageId: "m1",
      mode: "complete",
      fullText: "You have two cloud apps.",
      persistedMessageId: "server-1",
    });
    const msg = store.get()[0];
    expect(msg.id).toBe("server-1");
    expect(msg.text).toBe("You have two cloud apps.");
    expect(msg.provisional).toBeUndefined();
  });

  it("plain streamed replies never gain the marker (byte-identical behavior)", () => {
    const store = collect([assistant()]);
    store.apply({ messageId: "m1", mode: "replace", fullText: "Hello wor" });
    store.apply({ messageId: "m1", mode: "append", token: "ld." });
    const msg = store.get()[0];
    expect(msg.text).toBe("Hello world.");
    expect("provisional" in msg).toBe(false);
  });
});
