/**
 * Unit coverage for evidence analyzer registry in registry.ts.
 *
 * Tests analyzer list completeness, getAnalyzer lookup by name, tierRunnable
 * matrix evaluation, analyzersForTier filtering, and analyzersForKind filtering.
 */

import { describe, expect, it } from "vitest";
import {
  ANALYZERS,
  analyzersForKind,
  analyzersForTier,
  getAnalyzer,
  tierRunnable,
} from "./registry.js";

describe("evidence analyzer registry", () => {
  it("exports static ANALYZERS array containing all 10 built-in analyzers", () => {
    expect(Array.isArray(ANALYZERS)).toBe(true);
    expect(ANALYZERS.length).toBe(10);

    const names = ANALYZERS.map((a) => a.name);
    expect(names).toContain("ocr.tesseract");
    expect(names).toContain("ocr.unlimited");
    expect(names).toContain("color.palette");
    expect(names).toContain("color.corners");
    expect(names).toContain("brand.rules");
    expect(names).toContain("diff.change");
    expect(names).toContain("diff.region");
    expect(names).toContain("hash.perceptual");
    expect(names).toContain("tree.aria");
    expect(names).toContain("video.keyframes");
  });

  describe("getAnalyzer", () => {
    it("looks up an analyzer by exact dotted name", () => {
      const analyzer = getAnalyzer("ocr.tesseract");
      expect(analyzer).toBeDefined();
      expect(analyzer?.name).toBe("ocr.tesseract");
    });

    it("returns undefined for unknown analyzer names", () => {
      expect(getAnalyzer("nonexistent.analyzer")).toBeUndefined();
      expect(getAnalyzer("")).toBeUndefined();
    });
  });

  describe("tierRunnable", () => {
    it("allows cpu analyzers at all tiers", () => {
      expect(tierRunnable("cpu", "cpu")).toBe(true);
      expect(tierRunnable("cpu", "gpu")).toBe(true);
      expect(tierRunnable("cpu", "full")).toBe(true);
    });

    it("allows gpu analyzers only at gpu and full tiers", () => {
      expect(tierRunnable("gpu", "cpu")).toBe(false);
      expect(tierRunnable("gpu", "gpu")).toBe(true);
      expect(tierRunnable("gpu", "full")).toBe(true);
    });

    it("allows full analyzers only at full tier", () => {
      expect(tierRunnable("full", "cpu")).toBe(false);
      expect(tierRunnable("full", "gpu")).toBe(false);
      expect(tierRunnable("full", "full")).toBe(true);
    });
  });

  describe("analyzersForTier", () => {
    it("filters analyzers matching the specified execution tier", () => {
      const cpuAnalyzers = analyzersForTier("cpu");
      for (const analyzer of cpuAnalyzers) {
        expect(analyzer.tier).toBe("cpu");
      }

      const fullAnalyzers = analyzersForTier("full");
      expect(fullAnalyzers.length).toBe(ANALYZERS.length);
    });
  });

  describe("analyzersForKind", () => {
    it("filters analyzers consuming the specified artifact kind", () => {
      const screenshotAnalyzers = analyzersForKind("screenshot");
      expect(screenshotAnalyzers.length).toBeGreaterThan(0);
      for (const analyzer of screenshotAnalyzers) {
        expect(analyzer.kinds).toContain("screenshot");
      }
    });
  });
});
