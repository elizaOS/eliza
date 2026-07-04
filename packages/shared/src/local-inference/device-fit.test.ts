/**
 * Exercises `selectBestEliza1Fit` device-tier selection: the biggest tier that
 * fits a given RAM budget, always at the QJL KV quant, targeting the 128k window
 * — downscaling context near the floor and returning null (route to Cloud) when
 * not even a minimal local window fits. Also checks monotonicity in RAM and that
 * no sub-2B tier is ever picked. Pure Vitest over MODEL_CATALOG.
 */
import { describe, expect, it } from "vitest";
import { MODEL_CATALOG } from "./catalog";
import {
  ELIZA_1_CONTEXT_TARGET,
  ELIZA_1_KV_QUANT,
  ELIZA_1_MIN_LOCAL_CONTEXT,
  selectBestEliza1Fit,
} from "./device-fit";

const sizeOf = (id: string) =>
  MODEL_CATALOG.find((m) => m.id === id)?.minRamGb ?? Number.POSITIVE_INFINITY;
const biggestTier = [...MODEL_CATALOG].sort(
  (a, b) => b.minRamGb - a.minRamGb,
)[0];
const smallestTier = [...MODEL_CATALOG].sort(
  (a, b) => a.minRamGb - b.minRamGb,
)[0];

describe("selectBestEliza1Fit — biggest tier that fits, 128k target, QJL always", () => {
  it("picks the biggest tier on a huge device, at its native window", () => {
    const fit = selectBestEliza1Fit(128);
    expect(fit).not.toBeNull();
    expect(fit?.tierId).toBe(biggestTier.id);
    expect(fit?.reason).toBe("native-fit");
    expect(fit?.contextDownscaled).toBe(false);
    expect(fit?.contextLength).toBeGreaterThanOrEqual(ELIZA_1_CONTEXT_TARGET);
  });

  it("always uses the QJL KV quant", () => {
    for (const ram of [128, 32, 12, 8, 5, 3]) {
      expect(selectBestEliza1Fit(ram)?.kvQuant).toBe(ELIZA_1_KV_QUANT);
    }
  });

  it("hits the full 128k window for any device that fits the smallest tier", () => {
    const fit = selectBestEliza1Fit(smallestTier.minRamGb);
    expect(fit).not.toBeNull();
    expect(fit?.contextLength).toBeGreaterThanOrEqual(ELIZA_1_CONTEXT_TARGET);
    expect(fit?.contextDownscaled).toBe(false);
  });

  it("is monotonic — more RAM never yields a smaller tier", () => {
    let prev = 0;
    for (const ram of [3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 128]) {
      const fit = selectBestEliza1Fit(ram);
      if (!fit) continue;
      const cur = sizeOf(fit.tierId);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  it("keeps the smallest tier but shrinks context when 128k will not fit", () => {
    // Just below the smallest tier's full-fit floor, but enough for weights.
    const ram = smallestTier.minRamGb - 1.2;
    const fit = selectBestEliza1Fit(ram);
    if (fit) {
      expect(fit.tierId).toBe(smallestTier.id);
      expect(fit.reason).toBe("context-downscaled");
      expect(fit.contextDownscaled).toBe(true);
      expect(fit.contextLength).toBeLessThan(ELIZA_1_CONTEXT_TARGET);
      expect(fit.contextLength).toBeGreaterThanOrEqual(
        ELIZA_1_MIN_LOCAL_CONTEXT,
      );
    }
  });

  it("returns null (→ route to Cloud) when not even a minimal local window fits", () => {
    expect(selectBestEliza1Fit(0.5)).toBeNull();
    expect(selectBestEliza1Fit(0)).toBeNull();
    expect(selectBestEliza1Fit(-4)).toBeNull();
    expect(selectBestEliza1Fit(Number.NaN)).toBeNull();
  });

  it("never selects a tier below 2B (0.8B is removed)", () => {
    for (const ram of [3, 4, 6, 12, 32, 64]) {
      const fit = selectBestEliza1Fit(ram);
      if (fit) expect(fit.tierId).not.toMatch(/0_8b/);
    }
  });
});
