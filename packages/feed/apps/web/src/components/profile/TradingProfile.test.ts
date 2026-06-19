import { describe, expect, it } from "bun:test";

/**
 * Tests for TradingProfile - Market Price Calculation
 *
 * These tests verify that the price calculation handles
 * null/undefined market data gracefully (Issue #2 fix).
 */
describe("TradingProfile - Price Calculation", () => {
  /**
   * Helper to convert various numeric types to a number
   */
  const toNumber = (
    value: string | number | bigint | null | undefined,
  ): number => {
    if (value === null || value === undefined) return 0;
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return Number(value);
    const parsed = parseFloat(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  };

  /**
   * Replicates the calculateCurrentPrice function from TradingProfile
   * with the null safety fix applied
   */
  const calculateCurrentPrice = (market: {
    yesShares?: string | number | bigint | null;
    noShares?: string | number | bigint | null;
  }) => {
    const yesShares = toNumber(market.yesShares ?? 0);
    const noShares = toNumber(market.noShares ?? 0);
    const totalShares = yesShares + noShares;
    return totalShares === 0 ? 0.5 : yesShares / totalShares;
  };

  describe("calculateCurrentPrice", () => {
    it("should return 0.5 for empty markets", () => {
      expect(calculateCurrentPrice({ yesShares: 0, noShares: 0 })).toBe(0.5);
    });

    it("should return 0.5 for undefined shares", () => {
      expect(calculateCurrentPrice({})).toBe(0.5);
    });

    it("should return 0.5 for null shares", () => {
      expect(calculateCurrentPrice({ yesShares: null, noShares: null })).toBe(
        0.5,
      );
    });

    it("should handle only yesShares being undefined", () => {
      const result = calculateCurrentPrice({ noShares: 100 });
      // 0 / (0 + 100) = 0
      expect(result).toBe(0);
    });

    it("should handle only noShares being undefined", () => {
      const result = calculateCurrentPrice({ yesShares: 100 });
      // 100 / (100 + 0) = 1
      expect(result).toBe(1);
    });

    it("should calculate correct probability for balanced markets", () => {
      const result = calculateCurrentPrice({ yesShares: 100, noShares: 100 });
      // 100 / 200 = 0.5
      expect(result).toBe(0.5);
    });

    it("should calculate correct probability for unbalanced markets", () => {
      const result = calculateCurrentPrice({ yesShares: 75, noShares: 25 });
      // 75 / 100 = 0.75
      expect(result).toBe(0.75);
    });

    it("should handle string values", () => {
      const result = calculateCurrentPrice({ yesShares: "60", noShares: "40" });
      // 60 / 100 = 0.6
      expect(result).toBe(0.6);
    });

    it("should handle bigint values", () => {
      const result = calculateCurrentPrice({
        yesShares: BigInt(1000),
        noShares: BigInt(1000),
      });
      expect(result).toBe(0.5);
    });

    it("should handle mixed types", () => {
      const result = calculateCurrentPrice({
        yesShares: "50",
        noShares: 50,
      });
      expect(result).toBe(0.5);
    });
  });

  describe("toNumber helper", () => {
    it("should convert strings to numbers", () => {
      expect(toNumber("123.45")).toBe(123.45);
      expect(toNumber("0")).toBe(0);
      expect(toNumber("-10")).toBe(-10);
    });

    it("should return 0 for null and undefined", () => {
      expect(toNumber(null)).toBe(0);
      expect(toNumber(undefined)).toBe(0);
    });

    it("should return 0 for non-numeric strings", () => {
      expect(toNumber("abc")).toBe(0);
      expect(toNumber("")).toBe(0);
    });

    it("should pass through numbers unchanged", () => {
      expect(toNumber(42)).toBe(42);
      expect(toNumber(3.14)).toBe(3.14);
      expect(toNumber(-100)).toBe(-100);
    });

    it("should convert bigints", () => {
      expect(toNumber(BigInt(1000))).toBe(1000);
      expect(toNumber(BigInt(-500))).toBe(-500);
    });
  });
});
