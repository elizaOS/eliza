/**
 * Unit tests for analytics success rate display formatter.
 * Validates conversion from 0..1 fractions to 1-decimal-place percentage numbers.
 */
import { describe, expect, it } from "vitest";
import { toSuccessRatePercent } from "./format.ts";

describe("analytics format", () => {
  describe("toSuccessRatePercent", () => {
    it("converts 1.0 to 100%", () => {
      expect(toSuccessRatePercent(1.0)).toBe(100);
    });

    it("converts 0 to 0%", () => {
      expect(toSuccessRatePercent(0)).toBe(0);
    });

    it("rounds to one decimal place accurately", () => {
      expect(toSuccessRatePercent(0.9545)).toBe(95.5);
      expect(toSuccessRatePercent(0.33333)).toBe(33.3);
      expect(toSuccessRatePercent(0.125)).toBe(12.5);
      expect(toSuccessRatePercent(0.8888)).toBe(88.9);
    });
  });
});
