/** Unit coverage for atomic chat-snapshot pacing and cancellation authority. */

import { describe, expect, it } from "vitest";
import {
  advanceStreamingReveal,
  createStreamingRevealState,
  freezeStreamingReveal,
  hasPendingStreamingReveal,
  ingestStreamingReveal,
  STREAMING_REVEAL_ATOMIC_JUMP_CODEPOINTS,
  settleStreamingReveal,
} from "./streaming-reveal-policy";

function longAnswer(length = 640): string {
  const phrase = "The answer arrives as clear words with stable punctuation. ";
  return phrase.repeat(Math.ceil(length / phrase.length)).slice(0, length);
}

function drain(state: ReturnType<typeof createStreamingRevealState>) {
  const visible: string[] = [state.visibleText];
  let current = state;
  for (let index = 0; index < 1_000; index += 1) {
    if (!hasPendingStreamingReveal(current)) return { current, visible };
    current = advanceStreamingReveal(current);
    visible.push(current.visibleText);
  }
  throw new Error("streaming reveal did not drain within the safety bound");
}

describe("streaming reveal policy", () => {
  it("leaves genuine small token snapshots direct", () => {
    let state = createStreamingRevealState();
    for (const snapshot of ["Hel", "Hello", "Hello there", "Hello there!"]) {
      state = ingestStreamingReveal(state, snapshot);
      expect(state.visibleText).toBe(snapshot);
      expect(hasPendingStreamingReveal(state)).toBe(false);
    }
  });

  it("turns one large atomic snapshot into a useful partial first paint", () => {
    const answer = longAnswer();
    const state = ingestStreamingReveal(createStreamingRevealState(), answer);

    expect(state.authoritativeText).toBe(answer);
    expect(state.visibleText.length).toBeGreaterThan(0);
    expect(state.visibleText.length).toBeLessThan(answer.length);
    expect(answer.startsWith(state.visibleText)).toBe(true);
    expect(hasPendingStreamingReveal(state)).toBe(true);
  });

  it("drains monotonically to the exact authoritative terminal text", () => {
    const answer = longAnswer();
    const initial = settleStreamingReveal(
      ingestStreamingReveal(createStreamingRevealState(), answer),
      answer,
    );
    const { current, visible } = drain(initial);

    expect(current.visibleText).toBe(answer);
    expect(current.authoritativeText).toBe(answer);
    expect(current.terminal).toBe(true);
    expect(hasPendingStreamingReveal(current)).toBe(false);
    for (let index = 1; index < visible.length; index += 1) {
      expect(visible[index].length).toBeGreaterThan(visible[index - 1].length);
      expect(visible[index].startsWith(visible[index - 1])).toBe(true);
    }
  });

  it("paces a large terminal-only jump even when the provider emitted no tokens", () => {
    const answer = longAnswer();
    const state = settleStreamingReveal(createStreamingRevealState(), answer);

    expect(state.visibleText).not.toBe(answer);
    expect(answer.startsWith(state.visibleText)).toBe(true);
    expect(hasPendingStreamingReveal(state)).toBe(true);
  });

  it("freezes exactly the visible prefix and rejects every late old-turn frame", () => {
    const answer = longAnswer();
    const started = advanceStreamingReveal(
      ingestStreamingReveal(createStreamingRevealState(), answer),
    );
    const frozen = freezeStreamingReveal(started);
    const late = ingestStreamingReveal(frozen, `${answer} late hidden tail`);

    expect(frozen.authoritativeText).toBe(started.visibleText);
    expect(frozen.visibleText).toBe(started.visibleText);
    expect(frozen.phase).toBe("frozen");
    expect(hasPendingStreamingReveal(frozen)).toBe(false);
    expect(late).toBe(frozen);
  });

  it("applies a divergent authoritative final immediately", () => {
    const started = ingestStreamingReveal(
      createStreamingRevealState(),
      longAnswer(),
    );
    const corrected = "A corrected final response.";
    const settled = settleStreamingReveal(started, corrected);

    expect(settled.visibleText).toBe(corrected);
    expect(settled.authoritativeText).toBe(corrected);
    expect(hasPendingStreamingReveal(settled)).toBe(false);
  });

  it("keeps provisional action-callback text direct and replaceable", () => {
    const provisional = longAnswer();
    const state = ingestStreamingReveal(
      createStreamingRevealState(),
      provisional,
      true,
    );

    expect(state.visibleText).toBe(provisional);
    expect(state.provisional).toBe(true);
    expect(hasPendingStreamingReveal(state)).toBe(false);

    const final = settleStreamingReveal(state, "The authoritative final.");
    expect(final.visibleText).toBe("The authoritative final.");
    expect(final.provisional).toBe(false);
  });

  it("never splits surrogate pairs while revealing multilingual text", () => {
    const answer = `🙂 你好 مرحبا café ${"🌍 words ".repeat(80)}`;
    const { current, visible } = drain(
      ingestStreamingReveal(createStreamingRevealState(), answer),
    );

    expect(current.visibleText).toBe(answer);
    for (const snapshot of visible) {
      expect(snapshot).not.toMatch(/[\uD800-\uDBFF]$/u);
      expect(answer.startsWith(snapshot)).toBe(true);
    }
  });

  it("keeps the atomic threshold direct below the boundary and paced at it", () => {
    const below = "x".repeat(STREAMING_REVEAL_ATOMIC_JUMP_CODEPOINTS - 1);
    const at = "x".repeat(STREAMING_REVEAL_ATOMIC_JUMP_CODEPOINTS);

    expect(
      hasPendingStreamingReveal(
        ingestStreamingReveal(createStreamingRevealState(), below),
      ),
    ).toBe(false);
    expect(
      hasPendingStreamingReveal(
        ingestStreamingReveal(createStreamingRevealState(), at),
      ),
    ).toBe(true);
  });
});
