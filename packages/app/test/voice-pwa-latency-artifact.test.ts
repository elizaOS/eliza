/**
 * Unit coverage for the pure completeness-chain matcher used by the voice PWA
 * E2E latency-artifact helper (sol-voice-pwa-e2e). `chainContainsInOrder` is the
 * load-bearing subsequence check behind voice-pwa-trace.spec.ts's trace-chain
 * assertion (STT->transcript->...->playback in order), so its edge behaviour is
 * pinned here in a fast Bun/Vitest unit test rather than only exercised inside a
 * browser spec. Pure function, no DOM/mic/@playwright runtime needed.
 */
import { describe, expect, it } from "vitest";
import { chainContainsInOrder } from "./ui-smoke/helpers/voice-latency-artifact";

describe("chainContainsInOrder (voice trace completeness matcher)", () => {
  it("matches an exact in-order chain", () => {
    expect(
      chainContainsInOrder(
        ["voice.stt_start", "voice.transcript", "voice.playback_start"],
        ["voice.stt_start", "voice.transcript", "voice.playback_start"],
      ),
    ).toBe(true);
  });

  it("matches a SUBSEQUENCE: extra marks may interleave between expected ones", () => {
    expect(
      chainContainsInOrder(
        [
          "voice.stt_start",
          "voice.stt_interim", // extra, ignored
          "voice.transcript",
          "voice.llm_token", // extra, ignored
          "voice.playback_start",
        ],
        ["voice.stt_start", "voice.transcript", "voice.playback_start"],
      ),
    ).toBe(true);
  });

  it("rejects an OUT-OF-ORDER chain (playback before transcript)", () => {
    expect(
      chainContainsInOrder(
        ["voice.stt_start", "voice.playback_start", "voice.transcript"],
        ["voice.stt_start", "voice.transcript", "voice.playback_start"],
      ),
    ).toBe(false);
  });

  it("rejects a chain MISSING a required mark", () => {
    expect(
      chainContainsInOrder(
        ["voice.stt_start", "voice.playback_start"],
        ["voice.stt_start", "voice.transcript", "voice.playback_start"],
      ),
    ).toBe(false);
  });

  it("rejects an empty chain against a non-empty expected order", () => {
    expect(chainContainsInOrder([], ["voice.stt_start"])).toBe(false);
  });

  it("treats an empty expected order as trivially satisfied", () => {
    expect(chainContainsInOrder(["voice.anything"], [])).toBe(true);
    expect(chainContainsInOrder([], [])).toBe(true);
  });

  it("returns true as soon as the full order is seen, ignoring trailing marks", () => {
    expect(
      chainContainsInOrder(["a", "b", "c", "d-trailing"], ["a", "b", "c"]),
    ).toBe(true);
  });

  it("does not double-count a single chain entry for repeated expected marks", () => {
    // expectedOrder needs TWO 'a's; the chain supplies only one — must fail.
    expect(chainContainsInOrder(["a", "b"], ["a", "a"])).toBe(false);
    // ...and passes when the chain actually repeats the mark in order.
    expect(chainContainsInOrder(["a", "a", "b"], ["a", "a"])).toBe(true);
  });
});
