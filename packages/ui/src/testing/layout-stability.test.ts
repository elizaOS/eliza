/**
 * Unit coverage for the layout-stability helpers (cumulative shift, opacity-flash
 * detection). Pure functions over samples, no browser.
 */
import { describe, expect, it } from "vitest";
import {
  cumulativeLayoutShift,
  detectOpacityFlash,
  type OpacitySample,
  summarizeStability,
} from "./layout-stability";

describe("layout-stability tooling — proves the flicker math is real", () => {
  describe("cumulativeLayoutShift", () => {
    it("sums shift values, excluding input-triggered ones (matches CLS)", () => {
      expect(
        cumulativeLayoutShift([
          { value: 0.05, hadRecentInput: false },
          { value: 0.12, hadRecentInput: false },
          { value: 0.9, hadRecentInput: true }, // user-caused → excluded
        ]),
      ).toBeCloseTo(0.17);
    });

    it("excludes explicitly intentional transient motion", () => {
      expect(
        cumulativeLayoutShift([
          { value: 0.08, hadRecentInput: false, intentional: true },
          { value: 0.03, hadRecentInput: false },
        ]),
      ).toBeCloseTo(0.03);
    });

    it("is 0 for a perfectly stable view", () => {
      expect(cumulativeLayoutShift([])).toBe(0);
    });
  });

  describe("detectOpacityFlash", () => {
    it("flags a fade-out-then-in (the re-trigger flicker)", () => {
      const s: OpacitySample[] = [
        { t: 0, opacity: 1 },
        { t: 16, opacity: 0.5 },
        { t: 32, opacity: 0 }, // dipped to 0…
        { t: 48, opacity: 0.6 },
        { t: 64, opacity: 1 }, // …and came back → flash
      ];
      expect(detectOpacityFlash(s)).toBe(true);
    });

    it("does NOT flag a clean one-way fade-in on mount", () => {
      const s: OpacitySample[] = [
        { t: 0, opacity: 0 },
        { t: 16, opacity: 0.4 },
        { t: 32, opacity: 0.8 },
        { t: 48, opacity: 1 },
      ];
      expect(detectOpacityFlash(s)).toBe(false);
    });

    it("does NOT flag a steady, fully-opaque element", () => {
      const s: OpacitySample[] = [
        { t: 0, opacity: 1 },
        { t: 16, opacity: 1 },
        { t: 32, opacity: 1 },
      ];
      expect(detectOpacityFlash(s)).toBe(false);
    });

    it("ignores sub-threshold jitter", () => {
      const s: OpacitySample[] = [
        { t: 0, opacity: 1 },
        { t: 16, opacity: 0.95 },
        { t: 32, opacity: 1 },
      ];
      expect(detectOpacityFlash(s, 0.2)).toBe(false);
    });
  });

  describe("summarizeStability — pass/flag verdict", () => {
    it("flags when CLS exceeds budget", () => {
      const v = summarizeStability(
        [
          { value: 0.2, hadRecentInput: false },
          { value: 0.2, hadRecentInput: false },
        ],
        [],
        { maxCls: 0.1 },
      );
      expect(v.cls).toBeCloseTo(0.4);
      expect(v.shiftCount).toBe(2);
      expect(v.flagged).toBe(true);
    });

    it("flags when an opacity flash occurs even with zero CLS", () => {
      const v = summarizeStability(
        [],
        [
          { t: 0, opacity: 1 },
          { t: 16, opacity: 0 },
          { t: 32, opacity: 1 },
        ],
        { maxCls: 0.1 },
      );
      expect(v.cls).toBe(0);
      expect(v.flashed).toBe(true);
      expect(v.flagged).toBe(true);
    });

    it("passes a stable, no-flash view (the smooth target)", () => {
      const v = summarizeStability(
        [{ value: 0.02, hadRecentInput: false }],
        [
          { t: 0, opacity: 1 },
          { t: 16, opacity: 1 },
        ],
        { maxCls: 0.1 },
      );
      expect(v.flagged).toBe(false);
    });

    it("does not count intentional transient motion as a shift", () => {
      const v = summarizeStability(
        [
          { value: 0.2, hadRecentInput: false, intentional: true },
          { value: 0.02, hadRecentInput: false },
        ],
        [],
        { maxCls: 0.1 },
      );
      expect(v.cls).toBeCloseTo(0.02);
      expect(v.shiftCount).toBe(1);
      expect(v.flagged).toBe(false);
    });
  });
});
