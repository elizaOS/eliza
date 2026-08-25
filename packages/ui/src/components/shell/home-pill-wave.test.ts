/** Verifies the pure analyser-frame → bar-scale mapping for the home pill's
 * listening chip (#20483). Deterministic math-only tests — no DOM, no audio. */

import { describe, expect, it } from "vitest";

import { computeWaveBarScales, FLATLINE_SCALE } from "./home-pill-wave";

const BAR_COUNT = 15;

/** A silent analyser frame: byte time-domain data rests at 128. */
function silentFrame(size = 2048): Uint8Array {
  return new Uint8Array(size).fill(128);
}

/** A loud full-scale square-ish frame alternating between the byte extremes. */
function loudFrame(size = 2048): Uint8Array {
  const samples = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    samples[index] = index % 2 === 0 ? 0 : 255;
  }
  return samples;
}

describe("computeWaveBarScales", () => {
  it("flatlines every bar in silence — the honest dead-mic signal", () => {
    const scales = computeWaveBarScales(silentFrame(), BAR_COUNT);
    expect(scales).toHaveLength(BAR_COUNT);
    for (const scale of scales) expect(scale).toBe(FLATLINE_SCALE);
  });

  it("flatlines on an empty frame (analyser produced no data)", () => {
    const scales = computeWaveBarScales(new Uint8Array(0), BAR_COUNT);
    expect(scales).toHaveLength(BAR_COUNT);
    for (const scale of scales) expect(scale).toBe(FLATLINE_SCALE);
  });

  it("drives every bar above the flatline on loud audio, clamped to 1", () => {
    const scales = computeWaveBarScales(loudFrame(), BAR_COUNT);
    for (const scale of scales) {
      expect(scale).toBeGreaterThan(FLATLINE_SCALE);
      expect(scale).toBeLessThanOrEqual(1);
    }
  });

  it("keeps the center-weighted silhouette symmetric on uniform energy", () => {
    const scales = computeWaveBarScales(loudFrame(), BAR_COUNT);
    const center = (BAR_COUNT - 1) / 2;
    for (let index = 0; index < center; index += 1) {
      expect(scales[index]).toBeCloseTo(
        scales[BAR_COUNT - 1 - index] ?? Number.NaN,
        10,
      );
      expect(scales[index] ?? Number.NaN).toBeLessThanOrEqual(
        scales[index + 1] ?? Number.NaN,
      );
    }
  });

  it("localizes energy: a burst confined to the first segment only lifts the first bar", () => {
    const samples = silentFrame(1500); // 100 samples per bar
    for (let index = 0; index < 100; index += 1) samples[index] = 255;
    const scales = computeWaveBarScales(samples, BAR_COUNT);
    expect(scales[0] ?? Number.NaN).toBeGreaterThan(FLATLINE_SCALE);
    for (let index = 1; index < BAR_COUNT; index += 1) {
      expect(scales[index]).toBe(FLATLINE_SCALE);
    }
  });

  it("handles more bars than samples without dividing by zero", () => {
    const scales = computeWaveBarScales(loudFrame(4), BAR_COUNT);
    expect(scales).toHaveLength(BAR_COUNT);
    for (const scale of scales) {
      expect(Number.isFinite(scale)).toBe(true);
      expect(scale).toBeGreaterThanOrEqual(FLATLINE_SCALE);
    }
  });

  it("returns an empty result for a non-positive bar count", () => {
    expect(computeWaveBarScales(loudFrame(), 0)).toEqual([]);
    expect(computeWaveBarScales(loudFrame(), -3)).toEqual([]);
  });
});
