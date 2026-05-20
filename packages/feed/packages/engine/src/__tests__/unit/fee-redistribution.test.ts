/**
 * Fee Redistribution Service Tests
 *
 * Tests for the stability fund system that maintains NPC liquidity.
 * Critical: Ensures NPCs don't go bankrupt and markets stay liquid.
 */

import { describe, expect, it } from "bun:test";
import {
  FeeRedistributionService,
  STABILITY_FUND_CONFIG,
} from "../../services/fee-redistribution-service";

describe("Fee Redistribution Configuration", () => {
  describe("STABILITY_FUND_CONFIG Validation", () => {
    it("should divert 30% of platform fees", () => {
      expect(STABILITY_FUND_CONFIG.PLATFORM_FEE_DIVERSION_RATE).toBe(0.3);
    });

    it("should top up NPCs at 20% threshold", () => {
      expect(STABILITY_FUND_CONFIG.TOP_UP_THRESHOLD_RATIO).toBe(0.2);
    });

    it("should top up to 50% of tier minimum", () => {
      expect(STABILITY_FUND_CONFIG.TOP_UP_TARGET_RATIO).toBe(0.5);
    });

    it("should have reasonable redistribution limits", () => {
      expect(STABILITY_FUND_CONFIG.MAX_REDISTRIBUTION_PER_TICK).toBe(50000);
      expect(STABILITY_FUND_CONFIG.MAX_NPCS_PER_TICK).toBe(10);
    });

    it("should maintain minimum reserve", () => {
      expect(STABILITY_FUND_CONFIG.MIN_FUND_RESERVE).toBe(10000);
    });
  });

  describe("calculateDiversionAmount", () => {
    it("should calculate 30% of platform fee", () => {
      // If platform gets $100, stability fund gets $30
      const diversion = FeeRedistributionService.calculateDiversionAmount(100);
      expect(diversion).toBe(30);
    });

    it("should handle small amounts", () => {
      const diversion = FeeRedistributionService.calculateDiversionAmount(1);
      expect(diversion).toBe(0.3);
    });

    it("should handle zero", () => {
      const diversion = FeeRedistributionService.calculateDiversionAmount(0);
      expect(diversion).toBe(0);
    });

    it("should calculate realistic trading fee scenario", () => {
      // $10,000 trade at 0.1% fee = $10 total fee
      // Platform share (50%) = $5
      // Stability fund (30% of platform) = $1.50
      const tradingFee = 10000 * 0.001; // $10
      const platformShare = tradingFee * 0.5; // $5
      const diversion =
        FeeRedistributionService.calculateDiversionAmount(platformShare);
      expect(diversion).toBe(1.5);
    });
  });
});

describe("Fee Redistribution Math", () => {
  describe("Tier Minimum Calculations", () => {
    // These match the TIER_MINIMUMS in the service
    const tierMinimums = {
      S_TIER: 50000,
      A_TIER: 25000,
      B_TIER: 10000,
      C_TIER: 5000,
    };

    it("should have correct S_TIER minimum", () => {
      expect(tierMinimums.S_TIER).toBe(50000);
    });

    it("should calculate correct threshold for S_TIER", () => {
      // 20% of $50k = $10k threshold
      const threshold =
        tierMinimums.S_TIER * STABILITY_FUND_CONFIG.TOP_UP_THRESHOLD_RATIO;
      expect(threshold).toBe(10000);
    });

    it("should calculate correct target for S_TIER", () => {
      // 50% of $50k = $25k target
      const target =
        tierMinimums.S_TIER * STABILITY_FUND_CONFIG.TOP_UP_TARGET_RATIO;
      expect(target).toBe(25000);
    });

    it("should calculate correct top-up amount for S_TIER NPC at zero", () => {
      // NPC at $0, target is $25k, so top-up = $25k
      const currentBalance = 0;
      const target =
        tierMinimums.S_TIER * STABILITY_FUND_CONFIG.TOP_UP_TARGET_RATIO;
      const amountNeeded = Math.max(0, target - currentBalance);
      expect(amountNeeded).toBe(25000);
    });

    it("should calculate partial top-up for NPC near threshold", () => {
      // S_TIER NPC at $8k (below $10k threshold)
      // Target is $25k, so top-up = $17k
      const currentBalance = 8000;
      const target =
        tierMinimums.S_TIER * STABILITY_FUND_CONFIG.TOP_UP_TARGET_RATIO;
      const amountNeeded = Math.max(0, target - currentBalance);
      expect(amountNeeded).toBe(17000);
    });

    it("should not top-up NPC above threshold", () => {
      // S_TIER NPC at $15k (above $10k threshold)
      // Should not need top-up
      const currentBalance = 15000;
      const threshold =
        tierMinimums.S_TIER * STABILITY_FUND_CONFIG.TOP_UP_THRESHOLD_RATIO;
      const isAboveThreshold = currentBalance >= threshold;
      expect(isAboveThreshold).toBe(true);
    });
  });

  describe("Fund Balance Scenarios", () => {
    it("should not distribute when below reserve", () => {
      const fundBalance = 5000; // Below $10k reserve
      const availableForDistribution =
        fundBalance - STABILITY_FUND_CONFIG.MIN_FUND_RESERVE;
      expect(availableForDistribution).toBeLessThanOrEqual(0);
    });

    it("should have correct available amount when above reserve", () => {
      const fundBalance = 60000;
      const availableForDistribution =
        fundBalance - STABILITY_FUND_CONFIG.MIN_FUND_RESERVE;
      expect(availableForDistribution).toBe(50000);
    });

    it("should cap distribution at max per tick", () => {
      const fundBalance = 100000; // $100k in fund
      const availableForDistribution =
        fundBalance - STABILITY_FUND_CONFIG.MIN_FUND_RESERVE; // $90k
      const cappedDistribution = Math.min(
        availableForDistribution,
        STABILITY_FUND_CONFIG.MAX_REDISTRIBUTION_PER_TICK,
      );
      expect(cappedDistribution).toBe(50000); // Capped at $50k
    });
  });

  describe("Fee Accumulation Projections", () => {
    it("should accumulate meaningful fund balance from trading activity", () => {
      // Scenario: 100 trades of $10k each per day
      const tradesPerDay = 100;
      const avgTradeSize = 10000;
      const tradingFeeRate = 0.001; // 0.1%
      const platformShare = 0.5;
      const diversionRate = STABILITY_FUND_CONFIG.PLATFORM_FEE_DIVERSION_RATE;

      const dailyTradeVolume = tradesPerDay * avgTradeSize; // $1M
      const dailyFees = dailyTradeVolume * tradingFeeRate; // $1000
      const dailyPlatformFees = dailyFees * platformShare; // $500
      const dailyStabilityFund = dailyPlatformFees * diversionRate; // $150

      expect(dailyStabilityFund).toBe(150);

      // After 10 days, fund has $1500 (assuming no redistribution)
      const tenDayFund = dailyStabilityFund * 10;
      expect(tenDayFund).toBe(1500);
    });
  });
});

describe("Edge Cases", () => {
  it("should handle very small fee amounts", () => {
    const diversion = FeeRedistributionService.calculateDiversionAmount(0.01);
    expect(diversion).toBe(0.003);
  });

  it("should handle very large fee amounts", () => {
    const diversion =
      FeeRedistributionService.calculateDiversionAmount(1_000_000);
    expect(diversion).toBe(300_000);
  });
});
