/**
 * Cross-platform snapshot handoff coverage: web folds synchronously, validated
 * native parity becomes authoritative, stale replies cannot regress the UI,
 * and same-sequence divergence fails closed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptEvent } from "./contract";
import {
  acceptNativeTranscriptViewModel,
  applyRendererTranscriptEvents,
  getNativeTranscriptSnapshot,
  resetNativeTranscriptStoreForTests,
  subscribeNativeTranscript,
} from "./live-store";

const userFinal: TranscriptEvent = {
  type: "stt.final",
  seq: 1,
  turnId: "turn-1",
  text: "hello",
};

describe("native transcript live store", () => {
  beforeEach(resetNativeTranscriptStoreForTests);

  it("publishes the renderer fold immediately, then accepts Android parity", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNativeTranscript(listener);
    const renderer = applyRendererTranscriptEvents([userFinal]);
    expect(renderer.source).toBe("web");
    expect(renderer.view.items[0]).toMatchObject({
      kind: "user",
      id: "turn-1",
      text: "hello",
    });

    const accepted = acceptNativeTranscriptViewModel(
      structuredClone(renderer.view),
      "android",
    );
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.applied).toBe(true);
    expect(getNativeTranscriptSnapshot().source).toBe("android");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("ignores an older asynchronous native reply", () => {
    const first = applyRendererTranscriptEvents([userFinal]);
    applyRendererTranscriptEvents([
      {
        type: "agent.text",
        seq: 2,
        messageId: "message-1",
        turnId: "turn-1",
        text: "hi",
        final: true,
      },
    ]);

    const accepted = acceptNativeTranscriptViewModel(first.view, "ios");
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.applied).toBe(false);
    expect(getNativeTranscriptSnapshot()).toMatchObject({
      source: "web",
      view: { lastSeq: 2 },
    });
  });

  it("rejects same-sequence native divergence without replacing the product view", () => {
    const renderer = applyRendererTranscriptEvents([userFinal]);
    const divergent = structuredClone(renderer.view);
    const item = divergent.items[0];
    if (item.kind !== "user") throw new Error("expected user fixture row");
    item.text = "different";

    const accepted = acceptNativeTranscriptViewModel(divergent, "desktop");
    expect(accepted.ok).toBe(false);
    if (!accepted.ok) expect(accepted.error.message).toContain("diverged");
    expect(getNativeTranscriptSnapshot()).toEqual(renderer);
  });

  it("rejects a future native projection that the renderer did not publish", () => {
    const renderer = applyRendererTranscriptEvents([userFinal]);
    const future = structuredClone(renderer.view);
    future.lastSeq = 2;

    const accepted = acceptNativeTranscriptViewModel(future, "android");
    expect(accepted.ok).toBe(false);
    if (!accepted.ok) {
      expect(accepted.error).toMatchObject({
        path: "view.lastSeq",
      });
      expect(accepted.error.message).toContain("future seq 2");
    }
    expect(getNativeTranscriptSnapshot()).toEqual(renderer);
  });

  it("rejects malformed native state before it reaches subscribers", () => {
    applyRendererTranscriptEvents([userFinal]);
    const listener = vi.fn();
    const unsubscribe = subscribeNativeTranscript(listener);
    const accepted = acceptNativeTranscriptViewModel(
      { items: [], connection: "fine", speaking: null, lastSeq: 1 },
      "ios",
    );
    expect(accepted.ok).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
