/**
 * Unit tests for feedback calculation functions
 */

import { describe, expect, it } from "bun:test";
import {
  calculateGameScore,
  calculateTradeScore,
  type GameMetrics,
  type TradeMetrics,
} from "@feed/engine";

describe("Feedback Calculations", () => {
  describe("calculateTradeScore", () => {
    it("should calculate high score for profitable trade with good timing", () => {
      const metrics: TradeMetrics = {
        profitable: true,
        roi: 0.5, // 50% ROI
        holdingPeriod: 24, // 24 hours
        timingScore: 0.9, // Excellent timing
        riskScore: 0.8, // Good risk management
      };

      const score = calculateTradeScore(metrics);
      expect(score).toBeGreaterThan(70);
      expect(score).toBeLessThanOrEqual(100);
    });

    it("should calculate low score for unprofitable trade", () => {
      const metrics: TradeMetrics = {
        profitable: false,
        roi: -0.3, // -30% ROI
        holdingPeriod: 48,
        timingScore: 0.3,
        riskScore: 0.4,
      };

      const score = calculateTradeScore(metrics);
      expect(score).toBeLessThan(50);
      expect(score).toBeGreaterThanOrEqual(0);
    });

    it("should handle edge case: perfect trade", () => {
      const metrics: TradeMetrics = {
        profitable: true,
        roi: 1.0, // 100% ROI (max)
        holdingPeriod: 1,
        timingScore: 1.0, // Perfect timing
        riskScore: 1.0, // Perfect risk management
      };

      const score = calculateTradeScore(metrics);
      expect(score).toBe(100);
    });

    it("should handle edge case: worst trade", () => {
      const metrics: TradeMetrics = {
        profitable: false,
        roi: -0.5, // -50% ROI (min)
        holdingPeriod: 168,
        timingScore: 0.0,
        riskScore: 0.0,
      };

      const score = calculateTradeScore(metrics);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThan(20);
    });

    it("should normalize ROI correctly", () => {
      const metrics1: TradeMetrics = {
        profitable: true,
        roi: 0.0, // Break even
        holdingPeriod: 24,
        timingScore: 0.5,
        riskScore: 0.5,
      };

      const metrics2: TradeMetrics = {
        profitable: true,
        roi: 0.25, // 25% ROI
        holdingPeriod: 24,
        timingScore: 0.5,
        riskScore: 0.5,
      };

      const score1 = calculateTradeScore(metrics1);
      const score2 = calculateTradeScore(metrics2);

      expect(score2).toBeGreaterThan(score1);
    });
  });

  describe("calculateGameScore", () => {
    it("should calculate high score for winning game with good decisions", () => {
      const metrics: GameMetrics = {
        won: true,
        pnl: 500,
        positionsClosed: 5,
        finalBalance: 1500,
        startingBalance: 1000,
        decisionsCorrect: 8,
        decisionsTotal: 10,
        riskManagement: 0.8,
      };

      const score = calculateGameScore(metrics);
      expect(score).toBeGreaterThan(60);
      expect(score).toBeLessThanOrEqual(100);
    });

    it("should calculate lower score for losing game", () => {
      const metrics: GameMetrics = {
        won: false,
        pnl: -200,
        positionsClosed: 3,
        finalBalance: 800,
        startingBalance: 1000,
        decisionsCorrect: 3,
        decisionsTotal: 10,
        riskManagement: 0.3,
      };

      const score = calculateGameScore(metrics);
      expect(score).toBeLessThan(50);
      expect(score).toBeGreaterThanOrEqual(0);
    });

    it("should reward perfect decision-making", () => {
      const metrics: GameMetrics = {
        won: true,
        pnl: 300,
        positionsClosed: 4,
        finalBalance: 1300,
        startingBalance: 1000,
        decisionsCorrect: 10,
        decisionsTotal: 10, // 100% correct
        riskManagement: 0.9,
      };

      const score = calculateGameScore(metrics);
      expect(score).toBeGreaterThan(70);
    });

    it("should handle zero decisions gracefully", () => {
      const metrics: GameMetrics = {
        won: false,
        pnl: -100,
        positionsClosed: 0,
        finalBalance: 900,
        startingBalance: 1000,
        decisionsCorrect: 0,
        decisionsTotal: 0,
        riskManagement: 0.5, // Defaults to 0.5
      };

      const score = calculateGameScore(metrics);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });
  });
});
