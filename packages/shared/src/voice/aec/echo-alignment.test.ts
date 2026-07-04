/** Offline near↔far echo alignment (#12256) — deterministic synthetic DSP. */

import { describe, expect, it } from "vitest";
import { estimateEchoAlignment } from "./echo-alignment.js";

/**
 * Deterministic pseudo-speech: seeded noise through a one-pole low-pass with a
 * slow amplitude envelope. Noise-based (not shared sinusoids) so two different
 * seeds are genuinely uncorrelated — pure tones at common frequencies would
 * phase-align at some offset and fake a high NCC.
 */
function speechLike(n: number, seed: number): Float32Array {
  const out = new Float32Array(n);
  let state = seed >>> 0 || 1;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff - 0.5;
  };
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / 16000;
    lp = 0.85 * lp + 0.15 * rand();
    const envelope = 0.55 + 0.45 * Math.sin(2 * Math.PI * 2.3 * t + seed);
    out[i] = envelope * lp * 2.5;
  }
  return out;
}

describe("estimateEchoAlignment", () => {
  it("recovers the true offset of an attenuated echo inside a longer far window", () => {
    const far = speechLike(48_000, 7); // 3 s of playback
    const trueOffset = 6_400; // near begins 400 ms into the far window
    const nearLen = 32_000; // 2 s utterance
    const near = new Float32Array(nearLen);
    for (let i = 0; i < nearLen; i++) near[i] = 0.22 * far[i + trueOffset];

    const est = estimateEchoAlignment(near, far, { maxOffsetSamples: 16_000 });
    expect(Math.abs(est.offsetSamples - trueOffset)).toBeLessThanOrEqual(2);
    expect(est.confidence).toBeGreaterThan(0.9);
    expect(est.overlapSamples).toBe(nearLen);
  });

  it("recovers the offset under double-talk (user speech mixed over the echo)", () => {
    const far = speechLike(48_000, 11);
    const user = speechLike(32_000, 999);
    const trueOffset = 9_600; // 600 ms
    const near = new Float32Array(32_000);
    for (let i = 0; i < near.length; i++) {
      near[i] = 0.25 * far[i + trueOffset] + 0.3 * user[i];
    }
    const est = estimateEchoAlignment(near, far, { maxOffsetSamples: 16_000 });
    expect(Math.abs(est.offsetSamples - trueOffset)).toBeLessThanOrEqual(4);
    expect(est.confidence).toBeGreaterThan(0.3);
  });

  it("reports low confidence when near and far are independent (no echo)", () => {
    const far = speechLike(48_000, 21);
    const near = speechLike(32_000, 12345);
    const est = estimateEchoAlignment(near, far, { maxOffsetSamples: 16_000 });
    expect(est.confidence).toBeLessThan(0.3);
  });

  it("handles degenerate inputs without throwing", () => {
    expect(
      estimateEchoAlignment(new Float32Array(0), new Float32Array(0)),
    ).toEqual({ offsetSamples: 0, confidence: 0, overlapSamples: 0 });
    const tiny = estimateEchoAlignment(
      new Float32Array(10),
      new Float32Array(10),
      { minOverlapSamples: 4000 },
    );
    expect(tiny.confidence).toBe(0);
  });
});
