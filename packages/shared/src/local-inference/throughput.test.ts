/**
 * Covers `computeGenerationThroughput` — splitting prefill vs decode tok/s from
 * output counters and a measured TTFT, reporting null (never a fabricated zero)
 * when a window is unmeasurable (absent/impossible TTFT, non-positive duration,
 * nothing decoded, zero prompt tokens) — and the `isGenerationCounters` frame
 * guard. Pure Vitest over synthetic counter frames.
 */
import { describe, expect, it } from "vitest";
import {
  computeGenerationThroughput,
  isGenerationCounters,
} from "./throughput";

describe("computeGenerationThroughput", () => {
  it("differences prefill and decode tok/s from a measured TTFT", () => {
    // 64 prompt tokens processed in 200 ms prefill → 320 tok/s prefill.
    // 128 decoded tokens over the remaining 800 ms → 160 tok/s decode.
    const t = computeGenerationThroughput({
      promptTokens: 64,
      outputTokens: 128,
      durationMs: 1000,
      ttftMs: 200,
    });
    expect(t.prefillTokensPerSecond).toBeCloseTo(320, 5);
    expect(t.decodeTokensPerSecond).toBeCloseTo(160, 5);
    expect(t.combinedTokensPerSecond).toBeCloseTo(128, 5);
    expect(t.ttftMs).toBe(200);
    expect(t.decodeMs).toBe(800);
  });

  it("reports prefill/decode as null but keeps combined when TTFT is absent", () => {
    const t = computeGenerationThroughput({
      promptTokens: 64,
      outputTokens: 128,
      durationMs: 1000,
    });
    expect(t.prefillTokensPerSecond).toBeNull();
    expect(t.decodeTokensPerSecond).toBeNull();
    expect(t.ttftMs).toBeNull();
    expect(t.decodeMs).toBeNull();
    expect(t.combinedTokensPerSecond).toBeCloseTo(128, 5);
  });

  it("treats a non-positive duration as fully unmeasurable (no fabricated zeros)", () => {
    const t = computeGenerationThroughput({
      promptTokens: 64,
      outputTokens: 128,
      durationMs: 0,
    });
    expect(t.prefillTokensPerSecond).toBeNull();
    expect(t.decodeTokensPerSecond).toBeNull();
    expect(t.combinedTokensPerSecond).toBeNull();
  });

  it("reports null combined throughput when nothing was decoded", () => {
    const t = computeGenerationThroughput({
      promptTokens: 64,
      outputTokens: 0,
      durationMs: 500,
      ttftMs: 100,
    });
    // Prefill is still measurable (prompt was processed); decode/combined are not.
    expect(t.prefillTokensPerSecond).toBeCloseTo(640, 5);
    expect(t.decodeTokensPerSecond).toBeNull();
    expect(t.combinedTokensPerSecond).toBeNull();
  });

  it("ignores an impossible TTFT that meets or exceeds the total duration", () => {
    const t = computeGenerationThroughput({
      promptTokens: 32,
      outputTokens: 10,
      durationMs: 500,
      ttftMs: 500,
    });
    // ttft >= duration leaves no decode window, so the split is dropped and
    // only the combined figure survives.
    expect(t.ttftMs).toBeNull();
    expect(t.prefillTokensPerSecond).toBeNull();
    expect(t.decodeTokensPerSecond).toBeNull();
    expect(t.combinedTokensPerSecond).toBeCloseTo(20, 5);
  });

  it("does not divide by a zero prompt token count", () => {
    const t = computeGenerationThroughput({
      promptTokens: 0,
      outputTokens: 16,
      durationMs: 400,
      ttftMs: 50,
    });
    expect(t.prefillTokensPerSecond).toBeNull();
    expect(t.decodeTokensPerSecond).toBeCloseTo(16 / 0.35, 5);
  });
});

describe("isGenerationCounters", () => {
  it("accepts a well-formed frame with and without ttftMs", () => {
    expect(
      isGenerationCounters({ promptTokens: 1, outputTokens: 1, durationMs: 1 }),
    ).toBe(true);
    expect(
      isGenerationCounters({
        promptTokens: 1,
        outputTokens: 1,
        durationMs: 1,
        ttftMs: 1,
      }),
    ).toBe(true);
    expect(
      isGenerationCounters({
        promptTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        ttftMs: null,
      }),
    ).toBe(true);
  });

  it("rejects malformed frames", () => {
    expect(isGenerationCounters(null)).toBe(false);
    expect(isGenerationCounters({ promptTokens: 1, outputTokens: 1 })).toBe(
      false,
    );
    expect(
      isGenerationCounters({
        promptTokens: -1,
        outputTokens: 1,
        durationMs: 1,
      }),
    ).toBe(false);
    expect(
      isGenerationCounters({
        promptTokens: 1,
        outputTokens: 1,
        durationMs: 1,
        ttftMs: "fast",
      }),
    ).toBe(false);
  });
});
