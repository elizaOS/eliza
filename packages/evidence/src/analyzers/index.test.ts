/**
 * Unit coverage for the analyzers public barrel in index.ts.
 *
 * Consumers outside this folder (queue/executor.ts, queue/worker.ts,
 * src/index.ts) reach the analyzers only through this barrel, so the suite
 * drives the re-exported registry lookups, colour math, and perceptual-hash
 * helpers over that exact surface. Deterministic unit harness: real module
 * calls only, no mocks, no fixtures, no network.
 */

import { describe, expect, it } from "vitest";
import type { Analyzer } from "./index.js";
import {
  ANALYZERS,
  analyzersForKind,
  analyzersForTier,
  classifyColor,
  colorFractionsFromRaw,
  getAnalyzer,
  hammingDistance,
  isSameScreen,
  round4,
  SAME_SCREEN_THRESHOLD,
} from "./index.js";

const must = (name: string): Analyzer => {
  const analyzer = getAnalyzer(name);
  if (!analyzer) throw new Error(`analyzer ${name} is not registered`);
  return analyzer;
};

describe("evidence analyzers public barrel", () => {
  it("resolves every registered analyzer by name through one shared array", () => {
    const names = ANALYZERS.map((analyzer) => analyzer.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    for (const analyzer of ANALYZERS) {
      expect(getAnalyzer(analyzer.name)).toBe(analyzer);
    }
    expect(getAnalyzer("no.such.analyzer")).toBeUndefined();
    expect(getAnalyzer("")).toBeUndefined();
  });

  it("gates gpu-tier analyzers out of cpu runs and admits them at gpu/full", () => {
    const cpu = analyzersForTier("cpu");
    expect(cpu.length).toBeGreaterThan(0);
    expect(cpu.every((analyzer) => analyzer.tier === "cpu")).toBe(true);

    const gpuNames = analyzersForTier("gpu").map((analyzer) => analyzer.name);
    for (const name of cpu.map((analyzer) => analyzer.name)) {
      expect(gpuNames).toContain(name);
    }
    // The registry's lone gpu-tier lane is ocr.unlimited (ocr/ocr.ts).
    expect(gpuNames).toContain("ocr.unlimited");

    expect(analyzersForTier("full").length).toBe(ANALYZERS.length);
  });

  it("filters by artifact kind and honours an explicit subset over the default", () => {
    const screenshots = analyzersForKind("screenshot");
    expect(screenshots.length).toBeGreaterThan(0);
    for (const analyzer of screenshots) {
      expect(analyzer.kinds).toContain("screenshot");
      expect(ANALYZERS).toContain(analyzer);
    }

    const phash = must("hash.perceptual");
    expect(analyzersForKind("screenshot", [phash])).toEqual([phash]);
    expect(analyzersForKind("screenshot", [])).toEqual([]);
  });

  it("classifies pixels into the four brand buckets", () => {
    expect(classifyColor(0, 0, 200)).toBe("blue");
    expect(classifyColor(100, 100, 131)).toBe("blue");
    expect(classifyColor(220, 120, 60)).toBe("orange");
    expect(classifyColor(128, 130, 132)).toBe("neutral");
    expect(classifyColor(150, 140, 60)).toBe("other");
  });

  it("rounds colour outputs to the fixed four-decimal precision", () => {
    expect(round4(2 / 3)).toBe(0.6667);
    expect(round4(0.30000000000000004)).toBe(0.3);
    expect(round4(1)).toBe(1);
  });

  it("computes whole-frame fractions from raw RGBA buffers, ignoring alpha", () => {
    const buffer = new Uint8Array([
      0,
      0,
      200,
      255, // blue pixel
      220,
      120,
      60,
      255, // orange pixel
    ]);
    expect(colorFractionsFromRaw(buffer, 4)).toEqual({
      blue_fraction: 0.5,
      orange_fraction: 0.5,
      neutral_fraction: 0,
    });
    expect(colorFractionsFromRaw(new Uint8Array(), 3)).toEqual({
      blue_fraction: 0,
      orange_fraction: 0,
      neutral_fraction: 0,
    });
  });

  it("measures hamming distance between equal-length hex hashes", () => {
    expect(hammingDistance("ab".repeat(8), "ab".repeat(8))).toBe(0);
    expect(hammingDistance("f".repeat(16), "0".repeat(16))).toBe(64);
    expect(() => hammingDistance("ff", "fff")).toThrow(/phash length mismatch/);
  });

  it("reads two screens as the same inside the default eight-bit threshold", () => {
    expect(SAME_SCREEN_THRESHOLD).toBe(8);
    const base = "0".repeat(16);
    const same = `${base.slice(0, -2)}ff`;
    const apart = `${base.slice(0, -3)}1ff`;
    expect(same).toHaveLength(16);
    expect(apart).toHaveLength(16);
    expect(isSameScreen(base, same)).toBe(true);
    expect(isSameScreen(base, apart)).toBe(false);
    expect(isSameScreen(base, apart, 9)).toBe(true);
  });
});
