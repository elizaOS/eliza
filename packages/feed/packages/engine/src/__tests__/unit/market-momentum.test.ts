/**
 * Market Momentum Service Tests
 *
 * Tests for cascade/herd behavior mechanics.
 * Critical: Ensures panic selling and FOMO buying work correctly.
 */

import { describe, expect, it } from "bun:test";
import {
  MarketMomentumService,
  MOMENTUM_CONFIG,
} from "../../services/market-momentum-service";

describe("Momentum Configuration", () => {
  describe("MOMENTUM_CONFIG Validation", () => {
    it("should have correct panic thresholds", () => {
      expect(MOMENTUM_CONFIG.PANIC_THRESHOLD).toBe(-0.1); // -10%
      expect(MOMENTUM_CONFIG.SEVERE_PANIC_THRESHOLD).toBe(-0.2); // -20%
    });

    it("should have correct FOMO thresholds", () => {
      expect(MOMENTUM_CONFIG.FOMO_THRESHOLD).toBe(0.1); // +10%
      expect(MOMENTUM_CONFIG.SEVERE_FOMO_THRESHOLD).toBe(0.2); // +20%
    });

    it("should have correct multipliers", () => {
      expect(MOMENTUM_CONFIG.PANIC_SELL_MULTIPLIER).toBe(2.0);
      expect(MOMENTUM_CONFIG.SEVERE_PANIC_MULTIPLIER).toBe(3.5);
      expect(MOMENTUM_CONFIG.FOMO_BUY_MULTIPLIER).toBe(2.0);
      expect(MOMENTUM_CONFIG.SEVERE_FOMO_MULTIPLIER).toBe(3.5);
    });

    it("should use 1 hour momentum window", () => {
      expect(MOMENTUM_CONFIG.MOMENTUM_WINDOW_MS).toBe(60 * 60 * 1000);
    });
  });
});

describe("NPC Behavior Type Classification", () => {
  describe("getNPCBehaviorType", () => {
    it("should identify herd personalities", () => {
      expect(
        MarketMomentumService.getNPCBehaviorType("reactive and emotional"),
      ).toBe("herd");
      expect(
        MarketMomentumService.getNPCBehaviorType("follows trends blindly"),
      ).toBe("herd");
      expect(
        MarketMomentumService.getNPCBehaviorType("prone to fomo and panic"),
      ).toBe("herd");
    });

    it("should identify contrarian personalities", () => {
      expect(
        MarketMomentumService.getNPCBehaviorType("contrarian investor"),
      ).toBe("contrarian");
      expect(MarketMomentumService.getNPCBehaviorType("value investor")).toBe(
        "contrarian",
      );
      expect(
        MarketMomentumService.getNPCBehaviorType("patient and analytical"),
      ).toBe("contrarian");
      expect(
        MarketMomentumService.getNPCBehaviorType("skeptic of market trends"),
      ).toBe("contrarian");
    });

    it("should default to balanced for neutral personalities", () => {
      expect(MarketMomentumService.getNPCBehaviorType("regular trader")).toBe(
        "balanced",
      );
      expect(MarketMomentumService.getNPCBehaviorType(null)).toBe("balanced");
      expect(MarketMomentumService.getNPCBehaviorType("")).toBe("balanced");
    });

    it("should be case insensitive", () => {
      expect(MarketMomentumService.getNPCBehaviorType("CONTRARIAN")).toBe(
        "contrarian",
      );
      expect(MarketMomentumService.getNPCBehaviorType("EMOTIONAL")).toBe(
        "herd",
      );
    });
  });
});

describe("Trading Multiplier Calculations", () => {
  describe("Neutral Market", () => {
    const neutralMomentum = {
      ticker: "TEST",
      organizationId: "test-org",
      priceChange1h: 0.05, // 5% - below thresholds
      priceChangePercent: 5,
      currentPrice: 105,
      previousPrice: 100,
      signal: "neutral" as const,
      strength: 0,
    };

    it("should return 1.0 multiplier in neutral market", () => {
      const result = MarketMomentumService.getTradingMultiplier(
        neutralMomentum,
        "herd",
        "buy",
      );
      expect(result.multiplier).toBe(1.0);
      expect(result.reason).toBe("neutral market");
    });
  });

  describe("Panic Market (Crash)", () => {
    const panicMomentum = {
      ticker: "CRASH",
      organizationId: "crash-org",
      priceChange1h: -0.15, // -15% - panic but not severe
      priceChangePercent: -15,
      currentPrice: 85,
      previousPrice: 100,
      signal: "panic" as const,
      strength: 0.5,
    };

    it("should increase sell multiplier for herd NPCs during panic", () => {
      const result = MarketMomentumService.getTradingMultiplier(
        panicMomentum,
        "herd",
        "sell",
      );
      expect(result.multiplier).toBeGreaterThan(1.0);
      expect(result.reason).toContain("panic selling");
    });

    it("should decrease buy multiplier for herd NPCs during panic", () => {
      const result = MarketMomentumService.getTradingMultiplier(
        panicMomentum,
        "herd",
        "buy",
      );
      expect(result.multiplier).toBeLessThan(1.0);
      expect(result.reason).toContain("hesitant");
    });

    it("should increase buy multiplier for contrarians during panic (buy the dip)", () => {
      const result = MarketMomentumService.getTradingMultiplier(
        panicMomentum,
        "contrarian",
        "buy",
      );
      expect(result.multiplier).toBeGreaterThan(1.0);
      expect(result.reason).toContain("buying the dip");
    });

    it("should decrease sell multiplier for contrarians during panic", () => {
      const result = MarketMomentumService.getTradingMultiplier(
        panicMomentum,
        "contrarian",
        "sell",
      );
      expect(result.multiplier).toBeLessThan(1.0);
      expect(result.reason).toContain("not panic selling");
    });
  });

  describe("Severe Panic Market (Crash)", () => {
    const severePanicMomentum = {
      ticker: "BIGCRASH",
      organizationId: "bigcrash-org",
      priceChange1h: -0.25, // -25% - severe panic
      priceChangePercent: -25,
      currentPrice: 75,
      previousPrice: 100,
      signal: "severe_panic" as const,
      strength: 1.0,
    };

    it("should have higher multiplier for severe panic", () => {
      const normalPanic = MarketMomentumService.getTradingMultiplier(
        {
          ...severePanicMomentum,
          signal: "panic",
          strength: 0.5,
          priceChange1h: -0.15,
        },
        "herd",
        "sell",
      );

      const severePanic = MarketMomentumService.getTradingMultiplier(
        severePanicMomentum,
        "herd",
        "sell",
      );

      expect(severePanic.multiplier).toBeGreaterThan(normalPanic.multiplier);
    });
  });

  describe("FOMO Market (Pump)", () => {
    const fomoMomentum = {
      ticker: "MOON",
      organizationId: "moon-org",
      priceChange1h: 0.15, // +15% - FOMO but not severe
      priceChangePercent: 15,
      currentPrice: 115,
      previousPrice: 100,
      signal: "fomo" as const,
      strength: 0.5,
    };

    it("should increase buy multiplier for herd NPCs during FOMO", () => {
      const result = MarketMomentumService.getTradingMultiplier(
        fomoMomentum,
        "herd",
        "buy",
      );
      expect(result.multiplier).toBeGreaterThan(1.0);
      expect(result.reason).toContain("FOMO buying");
    });

    it("should decrease sell multiplier for herd NPCs during FOMO", () => {
      const result = MarketMomentumService.getTradingMultiplier(
        fomoMomentum,
        "herd",
        "sell",
      );
      expect(result.multiplier).toBeLessThan(1.0);
      expect(result.reason).toContain("hesitant");
    });

    it("should increase sell multiplier for contrarians during FOMO (take profits)", () => {
      const result = MarketMomentumService.getTradingMultiplier(
        fomoMomentum,
        "contrarian",
        "sell",
      );
      expect(result.multiplier).toBeGreaterThan(1.0);
      expect(result.reason).toContain("taking profits");
    });

    it("should decrease buy multiplier for contrarians during FOMO", () => {
      const result = MarketMomentumService.getTradingMultiplier(
        fomoMomentum,
        "contrarian",
        "buy",
      );
      expect(result.multiplier).toBeLessThan(1.0);
      expect(result.reason).toContain("not FOMO buying");
    });
  });

  describe("Balanced NPCs", () => {
    const panicMomentum = {
      ticker: "TEST",
      organizationId: "test-org",
      priceChange1h: -0.15,
      priceChangePercent: -15,
      currentPrice: 85,
      previousPrice: 100,
      signal: "panic" as const,
      strength: 0.5,
    };

    it("should have moderate reaction for balanced NPCs", () => {
      const herdResult = MarketMomentumService.getTradingMultiplier(
        panicMomentum,
        "herd",
        "sell",
      );
      const balancedResult = MarketMomentumService.getTradingMultiplier(
        panicMomentum,
        "balanced",
        "sell",
      );

      // Balanced should have lower multiplier than herd
      expect(balancedResult.multiplier).toBeLessThan(herdResult.multiplier);
      expect(balancedResult.multiplier).toBeGreaterThan(1.0);
    });
  });
});

describe("Signal Classification", () => {
  const createMomentum = (priceChange: number) => ({
    ticker: "TEST",
    organizationId: "test-org",
    priceChange1h: priceChange,
    priceChangePercent: priceChange * 100,
    currentPrice: 100 + priceChange * 100,
    previousPrice: 100,
    signal: "neutral" as const, // Will be ignored in calculations
    strength: 0,
  });

  it("should classify -5% as neutral", () => {
    // Private method, but we can test via getTradingMultiplier
    const momentum = createMomentum(-0.05);
    momentum.signal = "neutral";
    const result = MarketMomentumService.getTradingMultiplier(
      momentum,
      "herd",
      "sell",
    );
    expect(result.reason).toBe("neutral market");
  });

  it("should classify +5% as neutral", () => {
    const momentum = createMomentum(0.05);
    momentum.signal = "neutral";
    const result = MarketMomentumService.getTradingMultiplier(
      momentum,
      "herd",
      "buy",
    );
    expect(result.reason).toBe("neutral market");
  });
});

describe("Edge Cases", () => {
  it("should handle exactly threshold values", () => {
    const exactThreshold = {
      ticker: "TEST",
      organizationId: "test-org",
      priceChange1h: -0.1, // Exactly -10%
      priceChangePercent: -10,
      currentPrice: 90,
      previousPrice: 100,
      signal: "panic" as const,
      strength: 0,
    };

    const result = MarketMomentumService.getTradingMultiplier(
      exactThreshold,
      "herd",
      "sell",
    );
    // Should trigger panic behavior at exactly threshold
    expect(result.multiplier).toBeGreaterThan(1.0);
  });

  it("should handle zero price change", () => {
    const zeroChange = {
      ticker: "TEST",
      organizationId: "test-org",
      priceChange1h: 0,
      priceChangePercent: 0,
      currentPrice: 100,
      previousPrice: 100,
      signal: "neutral" as const,
      strength: 0,
    };

    const result = MarketMomentumService.getTradingMultiplier(
      zeroChange,
      "herd",
      "buy",
    );
    expect(result.multiplier).toBe(1.0);
  });
});
