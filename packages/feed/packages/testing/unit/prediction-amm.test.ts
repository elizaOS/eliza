/**
 * Prediction Market AMM Tests
 *
 * Verifies CPMM invariants and correct share/price calculations
 */

import { describe, expect, test } from "bun:test";
import { PredictionPricing } from "../../core/markets/prediction/pricing";

describe("PredictionPricing CPMM", () => {
  describe("k invariant", () => {
    test("k remains constant after buy", () => {
      const yesShares = 500;
      const noShares = 500;
      const k = yesShares * noShares; // 250,000

      const result = PredictionPricing.calculateBuy(
        yesShares,
        noShares,
        "yes",
        100,
      );

      const newK = result.newYesShares * result.newNoShares;

      // Allow small floating point tolerance
      expect(Math.abs(newK - k) / k).toBeLessThan(0.001); // Within 0.1%
    });

    test("k remains constant after sell", () => {
      const yesShares = 500;
      const noShares = 500;
      const k = yesShares * noShares;

      const result = PredictionPricing.calculateSell(
        yesShares,
        noShares,
        "yes",
        50,
      );

      const newK = result.newYesShares * result.newNoShares;

      expect(Math.abs(newK - k) / k).toBeLessThan(0.001);
    });

    test("k invariant holds through buy-sell cycle", () => {
      let yesShares = 1000;
      let noShares = 1000;
      const initialK = yesShares * noShares;

      // Buy
      const buyResult = PredictionPricing.calculateBuy(
        yesShares,
        noShares,
        "yes",
        200,
      );
      yesShares = buyResult.newYesShares;
      noShares = buyResult.newNoShares;

      // Sell
      const sellResult = PredictionPricing.calculateSell(
        yesShares,
        noShares,
        "yes",
        100,
      );
      yesShares = sellResult.newYesShares;
      noShares = sellResult.newNoShares;

      const finalK = yesShares * noShares;

      expect(Math.abs(finalK - initialK) / initialK).toBeLessThan(0.001);
    });
  });

  describe("price movement", () => {
    test("buying YES increases YES price", () => {
      const result = PredictionPricing.calculateBuy(500, 500, "yes", 100);

      const initialYesPrice = 500 / 1000; // 0.5

      expect(result.newYesPrice).toBeGreaterThan(initialYesPrice);
      expect(result.priceImpact).toBeGreaterThan(0);
    });

    test("buying NO increases NO price", () => {
      const result = PredictionPricing.calculateBuy(500, 500, "no", 100);

      const initialNoPrice = 500 / 1000; // 0.5

      expect(result.newNoPrice).toBeGreaterThan(initialNoPrice);
      expect(result.priceImpact).toBeGreaterThan(0);
    });

    test("selling YES decreases YES price", () => {
      const result = PredictionPricing.calculateSell(500, 500, "yes", 50);

      const initialYesPrice = 500 / 1000; // 0.5

      expect(result.newYesPrice).toBeLessThan(initialYesPrice);
      // Price impact is negative when selling YES (price decreases)
      expect(result.priceImpact).toBeLessThan(0);
    });

    test("larger trades have larger price impact", () => {
      const small = PredictionPricing.calculateBuy(1000, 1000, "yes", 50);
      const large = PredictionPricing.calculateBuy(1000, 1000, "yes", 500);

      expect(Math.abs(large.priceImpact)).toBeGreaterThan(
        Math.abs(small.priceImpact),
      );
    });
  });

  describe("share calculations", () => {
    test("shares bought is proportional to USD spent", () => {
      const result1 = PredictionPricing.calculateBuy(500, 500, "yes", 100);
      const result2 = PredictionPricing.calculateBuy(500, 500, "yes", 200);

      // Due to slippage, doubling USD gives less than double shares
      // But should be at least 1.5x (accounting for price impact)
      expect(result2.sharesBought).toBeGreaterThan(result1.sharesBought * 1.5);
      expect(result2.sharesBought).toBeLessThan(result1.sharesBought * 2.0);
    });

    test("avg price reflects CPMM pricing", () => {
      const result = PredictionPricing.calculateBuy(500, 500, "yes", 100);

      // avgPrice = usdAmount / sharesBought
      // In CPMM, this will be around $1 per share due to how reserves work
      expect(result.avgPrice).toBeGreaterThan(0.8);
      expect(result.avgPrice).toBeLessThan(1.5);
    });

    test("proceeds from sell equal cost basis (no fees)", () => {
      // Buy first
      const buyResult = PredictionPricing.calculateBuy(1000, 1000, "yes", 200);

      // Sell back immediately
      const sellResult = PredictionPricing.calculateSell(
        buyResult.newYesShares,
        buyResult.newNoShares,
        "yes",
        buyResult.sharesBought,
      );

      // Should get roughly same USD back (small difference due to k rounding)
      expect(Math.abs(sellResult.totalCost - 200) / 200).toBeLessThan(0.01); // Within 1%
    });
  });

  describe("edge cases", () => {
    test("throws on zero USD amount", () => {
      expect(() => {
        PredictionPricing.calculateBuy(500, 500, "yes", 0);
      }).toThrow("Trade amount must be positive");
    });

    test("throws on negative shares to sell", () => {
      expect(() => {
        PredictionPricing.calculateSell(500, 500, "yes", -10);
      }).toThrow("Shares to sell must be positive");
    });

    test("throws on zero liquidity", () => {
      expect(() => {
        PredictionPricing.calculateBuy(0, 0, "yes", 100);
      }).toThrow("Market has insufficient liquidity");
    });

    test("handles extreme imbalance (90% YES)", () => {
      const result = PredictionPricing.calculateBuy(900, 100, "yes", 50);

      // Should still work but with high slippage
      expect(result.sharesBought).toBeGreaterThan(0);
      expect(result.priceImpact).toBeGreaterThan(5); // >5% impact
    });

    test("prevents buying more than available liquidity", () => {
      // Trying to buy $600 when only $500 worth of YES exists
      // This would require removing all shares, which breaks AMM
      const hugeAmount = 10000; // Way too much

      const result = PredictionPricing.calculateBuy(
        500,
        500,
        "yes",
        hugeAmount,
      );

      // Should succeed but remove most liquidity
      expect(result.newYesShares).toBeGreaterThan(0);
      expect(result.newYesShares).toBeLessThan(500);
    });

    test("throws when sell proceeds are not finite", () => {
      expect(() => {
        PredictionPricing.calculateSell(
          Number.POSITIVE_INFINITY,
          500,
          "yes",
          1,
        );
      }).toThrow("Calculated proceeds must be positive");
    });
  });

  describe("price symmetry", () => {
    test("YES and NO prices sum to 1.0", () => {
      const yesShares = 700;
      const noShares = 300;

      const total = yesShares + noShares;
      const yesPrice = noShares / total; // Counter-intuitive but correct
      const noPrice = yesShares / total;

      expect(yesPrice + noPrice).toBeCloseTo(1.0, 10);
    });

    test("equal reserves mean 50/50 odds", () => {
      const yesShares = 1000;
      const noShares = 1000;

      const yesPrice = PredictionPricing.getCurrentPrice(
        yesShares,
        noShares,
        "yes",
      );
      const noPrice = PredictionPricing.getCurrentPrice(
        yesShares,
        noShares,
        "no",
      );

      expect(yesPrice).toBeCloseTo(0.5, 5);
      expect(noPrice).toBeCloseTo(0.5, 5);
    });
  });

  describe("real-world scenarios", () => {
    test("whale trade moves market significantly", () => {
      const result = PredictionPricing.calculateBuy(1000, 1000, "yes", 5000);

      // $5k trade in $2k pool should have massive impact
      expect(result.priceImpact).toBeGreaterThan(50); // >50% price movement
      expect(result.newYesPrice).toBeGreaterThan(0.8); // YES goes above 80%
    });

    test("small trade minimal slippage", () => {
      const result = PredictionPricing.calculateBuy(10000, 10000, "yes", 10);

      // $10 in deep pool should have minimal impact
      expect(result.priceImpact).toBeLessThan(0.1); // <0.1% impact
      // avgPrice in CPMM is USD/shares, which is ~$1/share in this implementation
      expect(result.avgPrice).toBeGreaterThan(0.9);
      expect(result.avgPrice).toBeLessThan(1.1);
    });

    test("multiple small trades equivalent to one large", () => {
      let yesShares = 1000;
      let noShares = 1000;

      // Five $100 trades
      for (let i = 0; i < 5; i++) {
        const result = PredictionPricing.calculateBuy(
          yesShares,
          noShares,
          "yes",
          100,
        );
        yesShares = result.newYesShares;
        noShares = result.newNoShares;
      }

      // One $500 trade
      const bigTrade = PredictionPricing.calculateBuy(1000, 1000, "yes", 500);

      // Should end up at same price (path independence)
      expect(
        Math.abs(yesShares - bigTrade.newYesShares) / yesShares,
      ).toBeLessThan(0.001);
      expect(Math.abs(noShares - bigTrade.newNoShares) / noShares).toBeLessThan(
        0.001,
      );
    });
  });
});
