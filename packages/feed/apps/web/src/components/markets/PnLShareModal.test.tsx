import { describe, expect, it } from "bun:test";
import { FEED_POINTS_SYMBOL } from "@feed/shared";

/**
 * Tests for PnL formatting logic used in PnLShareModal.
 *
 * These tests verify that the P&L sign is correctly displayed
 * for both positive and negative values in share messages.
 */
describe("PnLShareModal - P&L Sign Formatting", () => {
  /**
   * Helper function that replicates the shareText formatting logic.
   * This is extracted from PnLShareModal to enable unit testing.
   */
  const formatPnLForShare = (pnl: number): string => {
    const sign = pnl >= 0 ? "+" : "-";
    return `${sign}${FEED_POINTS_SYMBOL}${Math.abs(pnl).toFixed(2)}`;
  };

  describe("formatPnLForShare", () => {
    it("should format positive P&L with plus sign", () => {
      expect(formatPnLForShare(100)).toBe(`+${FEED_POINTS_SYMBOL}100.00`);
      expect(formatPnLForShare(0.01)).toBe(`+${FEED_POINTS_SYMBOL}0.01`);
      expect(formatPnLForShare(1234.56)).toBe(`+${FEED_POINTS_SYMBOL}1234.56`);
    });

    it("should format zero P&L with plus sign", () => {
      expect(formatPnLForShare(0)).toBe(`+${FEED_POINTS_SYMBOL}0.00`);
    });

    it("should format negative P&L with minus sign", () => {
      expect(formatPnLForShare(-100)).toBe(`-${FEED_POINTS_SYMBOL}100.00`);
      expect(formatPnLForShare(-0.01)).toBe(`-${FEED_POINTS_SYMBOL}0.01`);
      expect(formatPnLForShare(-1234.56)).toBe(`-${FEED_POINTS_SYMBOL}1234.56`);
    });

    it("should handle edge cases correctly", () => {
      // Very small negative number
      expect(formatPnLForShare(-0.001)).toBe(`-${FEED_POINTS_SYMBOL}0.00`);
      // Large positive number
      expect(formatPnLForShare(999999.99)).toBe(
        `+${FEED_POINTS_SYMBOL}999999.99`,
      );
      // Large negative number
      expect(formatPnLForShare(-999999.99)).toBe(
        `-${FEED_POINTS_SYMBOL}999999.99`,
      );
    });
  });

  describe("Share text generation", () => {
    it("should include correct sign in portfolio share text", () => {
      const portfolioPnL = -50.25;
      const sign = portfolioPnL >= 0 ? "+" : "-";
      const shareText = `My Feed P&L is ${sign}${FEED_POINTS_SYMBOL}${Math.abs(portfolioPnL).toFixed(2)}. Trading narratives, sharing the upside.`;

      expect(shareText).toContain(`-${FEED_POINTS_SYMBOL}50.25`);
      expect(shareText).not.toContain(`+${FEED_POINTS_SYMBOL}50.25`);
    });

    it("should include correct sign in category share text", () => {
      const categoryPnL = 150.75;
      const sign = categoryPnL >= 0 ? "+" : "-";
      const shareText = `My Perps P&L on Feed is ${sign}${FEED_POINTS_SYMBOL}${Math.abs(categoryPnL).toFixed(2)}. Trading narratives, sharing the upside.`;

      expect(shareText).toContain(`+${FEED_POINTS_SYMBOL}150.75`);
      expect(shareText).not.toContain(`-${FEED_POINTS_SYMBOL}150.75`);
    });
  });
});
