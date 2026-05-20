import { describe, expect, it } from 'bun:test';
import { PredictionPricing } from '@feed/core/markets/prediction';

describe('Prediction market price scaling', () => {
  it('CPMM avgPrice can exceed 1.0 for large trades', () => {
    // Market with 5000/5000 liquidity (10k initial)
    const result = PredictionPricing.calculateBuy(5000, 5000, 'yes', 2000);

    // avgPrice = usdAmount / sharesBought
    // For a $2000 buy on a 50/50 market, cost-per-share > 1
    expect(result.avgPrice).toBeGreaterThan(1.0);
    expect(result.sharesBought).toBeGreaterThan(0);
    expect(result.sharesBought).toBeLessThan(2000);
  });

  it('avgPrice should NOT be multiplied by 100 for storage', () => {
    const result = PredictionPricing.calculateBuy(5000, 5000, 'yes', 1000);

    // The raw avgPrice is the correct value for entryPrice storage
    // Multiplying by 100 would create values like 140 for a $1.40 cost-per-share
    const correctEntryPrice = result.avgPrice;
    const wrongEntryPrice = result.avgPrice * 100;

    // Correct entry price should be in a reasonable range (0.x to ~2.x)
    expect(correctEntryPrice).toBeLessThan(5);
    expect(correctEntryPrice).toBeGreaterThan(0);

    // Wrong entry price would be 100x too large
    expect(wrongEntryPrice).toBeGreaterThan(50);
  });

  it('market prices (yesPrice/noPrice) ARE 0-1 probabilities', () => {
    const result = PredictionPricing.calculateBuy(5000, 5000, 'yes', 1000);

    // newYesPrice and newNoPrice should sum to ~1.0
    expect(result.newYesPrice + result.newNoPrice).toBeCloseTo(1.0, 5);
    expect(result.newYesPrice).toBeGreaterThan(0);
    expect(result.newYesPrice).toBeLessThan(1);
    expect(result.newNoPrice).toBeGreaterThan(0);
    expect(result.newNoPrice).toBeLessThan(1);
  });

  it('small trades have avgPrice close to 1.0 (cost per share)', () => {
    const result = PredictionPricing.calculateBuy(5000, 5000, 'yes', 10);

    // avgPrice is cost-per-share, NOT probability. On a balanced market
    // you pay ~$1 per share, so avgPrice ≈ 1.0
    expect(result.avgPrice).toBeCloseTo(1.0, 0);
  });

  it('large trades have avgPrice much higher than market price', () => {
    const result = PredictionPricing.calculateBuy(5000, 5000, 'yes', 4000);

    // Large trade moves the price significantly: avgPrice >> initial 0.5
    expect(result.avgPrice).toBeGreaterThan(1.5);
  });

  it('calculateExpectedPayout returns cost basis when no aggregate pool args are used', () => {
    const shares = 100;
    const avgPrice = 0.6;

    const payout = PredictionPricing.calculateExpectedPayout(shares, avgPrice);
    // With totalWinnerShares <= 0, resolution helper returns cost basis only
    expect(payout).toBe(shares * avgPrice);
  });

  it('calculateExpectedPayout adds proportional share of loser deposits', () => {
    const shares = 100;
    const avgPrice = 0.6;
    const totalWinnerShares = 100;
    const totalLoserDeposits = 100;

    const payout = PredictionPricing.calculateExpectedPayout(
      shares,
      avgPrice,
      totalWinnerShares,
      totalLoserDeposits
    );
    const costBasis = shares * avgPrice;
    expect(payout).toBe(costBasis + totalLoserDeposits);
  });
});

describe('Price storage conventions', () => {
  it('entryPrice should store raw avgPrice without * 100', () => {
    // Simulate what trade-execution-service does
    const result = PredictionPricing.calculateBuy(5000, 5000, 'yes', 2000);

    // CORRECT: store raw avgPrice
    const correctEntryPrice = result.avgPrice;
    expect(correctEntryPrice).toBeGreaterThan(0);
    expect(correctEntryPrice).toBeLessThan(5);

    // WRONG (the old bug): store avgPrice * 100
    const wrongEntryPrice = result.avgPrice * 100;
    expect(wrongEntryPrice).toBeGreaterThan(100);
  });

  it('currentPrice should store raw market probability without * 100', () => {
    const result = PredictionPricing.calculateBuy(5000, 5000, 'yes', 2000);

    // Market prices ARE 0-1 probabilities
    const correctCurrentPrice = result.newYesPrice;
    expect(correctCurrentPrice).toBeGreaterThan(0);
    expect(correctCurrentPrice).toBeLessThan(1);

    // WRONG: * 100 would make it 50-99
    const wrongCurrentPrice = result.newYesPrice * 100;
    expect(wrongCurrentPrice).toBeGreaterThan(50);
  });

  it('sell avgPrice follows the same convention as buy', () => {
    // Set up: buy first to move the market
    const buyResult = PredictionPricing.calculateBuy(5000, 5000, 'yes', 1000);

    // Then sell some shares
    const sellResult = PredictionPricing.calculateSell(
      buyResult.newYesShares,
      buyResult.newNoShares,
      'yes',
      500
    );

    // Sell avgPrice is proceeds/shares, same scale as buy avgPrice
    expect(sellResult.avgPrice).toBeGreaterThan(0);
    expect(sellResult.avgPrice).toBeLessThan(5);
  });

  it('entryPrice and currentPrice should be comparable in scale', () => {
    const result = PredictionPricing.calculateBuy(5000, 5000, 'yes', 1000);

    const entryPrice = result.avgPrice; // cost per share (~1.0)
    const currentPrice = result.newYesPrice; // probability (0-1)

    // These are in different units but both < 5. The old bug made
    // entryPrice 100x larger, creating massive fake PnL
    expect(entryPrice).toBeLessThan(5);
    expect(currentPrice).toBeLessThan(1);

    // The ratio should be reasonable (not 100x different)
    expect(entryPrice / currentPrice).toBeLessThan(10);
  });
});
