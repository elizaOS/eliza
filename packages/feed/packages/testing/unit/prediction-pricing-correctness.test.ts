/**
 * Prediction Market Pricing Correctness Tests
 *
 * Verifies CPMM buy/sell math, k-invariant preservation, pool-proportional
 * payout model with concrete numerical examples, and fee integration.
 */
import { describe, expect, test } from 'bun:test';

// Import pricing directly — no mocks needed for pure math
import { PredictionPricing } from '../../core/markets/prediction/pricing';

// ─── CPMM Buy/Sell Math ─────────────────────────────────────────────────────

describe('CPMM constant product math', () => {
  const Y = 5000; // yesShares
  const N = 5000; // noShares
  const K = Y * N; // 25_000_000

  test('buy YES: k-invariant holds after trade', () => {
    const result = PredictionPricing.calculateBuy(Y, N, 'yes', 100);
    const kAfter = result.newYesShares * result.newNoShares;
    // k should be preserved (CPMM: USD added to NO side, YES removed)
    expect(kAfter).toBeCloseTo(K, 0);
  });

  test('buy NO: k-invariant holds after trade', () => {
    const result = PredictionPricing.calculateBuy(Y, N, 'no', 100);
    const kAfter = result.newYesShares * result.newNoShares;
    expect(kAfter).toBeCloseTo(K, 0);
  });

  test('sell YES: k-invariant holds after trade', () => {
    // Sell 100 YES shares back into the pool
    const result = PredictionPricing.calculateSell(Y, N, 'yes', 100);
    const kAfter = result.newYesShares * result.newNoShares;
    expect(kAfter).toBeCloseTo(K, 0);
  });

  test('buy YES in 50/50 market: exact share calculation', () => {
    // Pool: 5000/5000, buy $100 YES
    // newNoShares = 5000 + 100 = 5100
    // newYesShares = 25_000_000 / 5100 ≈ 4901.96
    // sharesBought = 5000 - 4901.96 ≈ 98.04
    const result = PredictionPricing.calculateBuy(Y, N, 'yes', 100);
    expect(result.sharesBought).toBeCloseTo(98.04, 1);
    expect(result.newNoShares).toBe(5100);
    expect(result.newYesShares).toBeCloseTo(25_000_000 / 5100, 6);
    // avgPrice = 100 / 98.04 ≈ 1.02 (slightly above YES price due to slippage)
    expect(result.avgPrice).toBeCloseTo(1.02, 1);
  });

  test('buy YES in skewed market (80/20): cheaper shares', () => {
    // Pool where YES is cheap (underdog): yesShares=8000, noShares=2000
    // YES price = 2000/10000 = 0.20, NO price = 0.80
    const result = PredictionPricing.calculateBuy(8000, 2000, 'yes', 100);
    // newNoShares = 2000 + 100 = 2100
    // newYesShares = 16_000_000 / 2100 ≈ 7619.05
    // sharesBought = 8000 - 7619.05 ≈ 380.95
    expect(result.sharesBought).toBeCloseTo(380.95, 0);
    // avgPrice ≈ 100/380.95 ≈ 0.2625 — close to YES price of 0.20
    expect(result.avgPrice).toBeCloseTo(0.2625, 2);
  });

  test('large buy moves price significantly', () => {
    // Buy $2500 YES in 5000/5000 pool (50% of one side)
    const result = PredictionPricing.calculateBuy(Y, N, 'yes', 2500);
    // newNoShares = 7500, newYesShares = 25_000_000/7500 ≈ 3333.33
    // YES price moves from 0.50 to 7500/10833.33 ≈ 0.692
    expect(result.newYesPrice).toBeCloseTo(0.692, 2);
    expect(result.newNoPrice).toBeCloseTo(0.308, 2);
    // sharesBought = 5000 - 3333.33 ≈ 1666.67
    expect(result.sharesBought).toBeCloseTo(1666.67, 0);
  });

  test('sell recovers exact buy cost (no-fee CPMM is reversible)', () => {
    // Buy then sell: without fees, CPMM is mathematically reversible
    // k is recalculated from current reserves each trade, so round-trip is exact
    const buy = PredictionPricing.calculateBuy(Y, N, 'yes', 100);
    const sell = PredictionPricing.calculateSell(
      buy.newYesShares,
      buy.newNoShares,
      'yes',
      buy.sharesBought
    );
    // Proceeds equal the $100 spent (perfect reversal without fees)
    expect(sell.totalCost).toBeCloseTo(100, 6);
  });

  test('round-trip WITH fees loses money', () => {
    // With 1% fee on both buy and sell, round-trip should cost ~2%
    const feeRate = 0.01;
    const buy = PredictionPricing.calculateBuyWithFees(
      Y,
      N,
      'yes',
      100,
      feeRate
    );
    const sell = PredictionPricing.calculateSellWithFees(
      buy.newYesShares,
      buy.newNoShares,
      'yes',
      buy.sharesBought,
      feeRate
    );
    // Net proceeds after fees should be less than $100
    expect(sell.netProceeds).toBeLessThan(100);
    // Lost ~2% to fees (1% each way)
    expect(sell.netProceeds).toBeGreaterThan(96);
  });
});

// ─── Fee Integration ─────────────────────────────────────────────────────────

describe('CPMM fee integration', () => {
  test('buyWithFees deducts fee before calculating shares', () => {
    const feeRate = 0.01; // 1%
    const result = PredictionPricing.calculateBuyWithFees(
      5000,
      5000,
      'yes',
      100,
      feeRate
    );
    expect(result.fee).toBeCloseTo(1.0, 10); // 1% of 100
    expect(result.netAmount).toBeCloseTo(99, 10);
    // Shares should be based on $99 not $100
    const noFee = PredictionPricing.calculateBuy(5000, 5000, 'yes', 99);
    expect(result.sharesBought).toBeCloseTo(noFee.sharesBought, 6);
  });

  test('sellWithFees deducts fee from gross proceeds', () => {
    const feeRate = 0.01;
    const result = PredictionPricing.calculateSellWithFees(
      5000,
      5000,
      'yes',
      100,
      feeRate
    );
    const noFee = PredictionPricing.calculateSell(5000, 5000, 'yes', 100);
    expect(result.fee).toBeCloseTo(noFee.totalCost * 0.01, 6);
    expect(result.netProceeds).toBeCloseTo(noFee.totalCost - result.fee, 6);
  });
});

// ─── Pool-Proportional Payout Model ─────────────────────────────────────────

describe('pool-proportional payout model', () => {
  test('50/50 market, equal bets → winner doubles money', () => {
    // Alice bets $100 YES (gets shares), Bob bets $100 NO
    // Both buy in 50/50 market, so avgPrice ≈ $1.02/share
    // But conceptually: Alice deposits $100, Bob deposits $100
    // YES wins → Alice gets her $100 back + all of Bob's $100 = $200
    const aliceShares = 100;
    const aliceAvg = 1.0; // simplified: $1 per share
    const bobShares = 100;
    const bobAvg = 1.0;

    const totalWinnerShares = aliceShares;
    const totalLoserDeposits = bobShares * bobAvg; // $100

    const payout = PredictionPricing.calculateExpectedPayout(
      aliceShares,
      aliceAvg,
      totalWinnerShares,
      totalLoserDeposits
    );
    // costBasis = 100 * 1.0 = 100
    // + proportion(100/100) * loserDeposits(100) = 100
    // total = 200
    expect(payout).toBe(200);
  });

  test('80/20 market: favorite wins → small profit', () => {
    // 4 people bet $100 YES each (favorite), 1 person bets $100 NO (underdog)
    // YES wins
    const winnerShares = 400; // total YES shares across 4 winners
    const loserDeposits = 100; // 1 loser's deposit

    // Each winner's payout:
    const perWinner = PredictionPricing.calculateExpectedPayout(
      100, // each winner has 100 shares
      1.0, // avgPrice
      winnerShares,
      loserDeposits
    );
    // costBasis = 100, proportion = 100/400 = 0.25, loserShare = 0.25 * 100 = 25
    // payout = 100 + 25 = 125 (25% profit on $100 bet)
    expect(perWinner).toBe(125);
  });

  test('80/20 market: underdog wins → big profit', () => {
    // 4 people bet $100 YES (favorite), 1 person bets $100 NO (underdog)
    // NO wins (underdog wins)
    const winnerShares = 100; // 1 underdog winner
    const loserDeposits = 400; // 4 losers × $100 each

    const payout = PredictionPricing.calculateExpectedPayout(
      100,
      1.0,
      winnerShares,
      loserDeposits
    );
    // costBasis = 100, proportion = 100/100 = 1.0, loserShare = 400
    // payout = 100 + 400 = 500 (400% profit — 5x return on $100 bet)
    expect(payout).toBe(500);
  });

  test('all on one side (no losers) → winners get cost basis back', () => {
    // Everyone bets YES, YES wins → no loser deposits to distribute
    const payout = PredictionPricing.calculateExpectedPayout(
      50,
      0.8,
      200, // totalWinnerShares
      0 // no losers
    );
    // costBasis = 50 * 0.8 = 40, proportion * 0 = 0
    expect(payout).toBe(40);
  });

  test('single trader wins → gets cost basis back', () => {
    const payout = PredictionPricing.calculateExpectedPayout(
      100,
      0.5,
      100, // only winner
      0 // no losers
    );
    expect(payout).toBe(50); // costBasis = 100 * 0.5
  });

  test('multiple winners split losers proportionally to shares', () => {
    // Alice: 300 shares @ 0.50, Bob: 100 shares @ 0.60
    // Loser deposits: $500
    const totalWinnerShares = 400;
    const totalLoserDeposits = 500;

    const alicePayout = PredictionPricing.calculateExpectedPayout(
      300,
      0.5,
      totalWinnerShares,
      totalLoserDeposits
    );
    const bobPayout = PredictionPricing.calculateExpectedPayout(
      100,
      0.6,
      totalWinnerShares,
      totalLoserDeposits
    );

    // Alice: costBasis=150, proportion=300/400=0.75, loserShare=0.75*500=375
    // payout = 150 + 375 = 525
    expect(alicePayout).toBe(525);

    // Bob: costBasis=60, proportion=100/400=0.25, loserShare=0.25*500=125
    // payout = 60 + 125 = 185
    expect(bobPayout).toBe(185);

    // Total payouts = 525 + 185 = 710
    // Total deposits = alice(150) + bob(60) + losers(500) = 710
    // Zero-sum ✓
    const totalPayouts = alicePayout + bobPayout;
    const totalDeposits = 300 * 0.5 + 100 * 0.6 + totalLoserDeposits;
    expect(totalPayouts).toBeCloseTo(totalDeposits, 10);
  });

  test('zero-sum verification: total payouts = total deposits', () => {
    // 3 winners, 2 losers, varying sizes
    const winners = [
      { shares: 200, avgPrice: 0.4 },
      { shares: 150, avgPrice: 0.55 },
      { shares: 50, avgPrice: 0.7 },
    ];
    const losers = [
      { shares: 300, avgPrice: 0.45 },
      { shares: 100, avgPrice: 0.6 },
    ];

    const totalWinnerShares = winners.reduce((s, w) => s + w.shares, 0);
    const totalLoserDeposits = losers.reduce(
      (s, l) => s + l.shares * l.avgPrice,
      0
    );

    let totalPayouts = 0;
    for (const w of winners) {
      totalPayouts += PredictionPricing.calculateExpectedPayout(
        w.shares,
        w.avgPrice,
        totalWinnerShares,
        totalLoserDeposits
      );
    }

    const totalWinnerDeposits = winners.reduce(
      (s, w) => s + w.shares * w.avgPrice,
      0
    );
    // Total payouts = total winner deposits + total loser deposits
    expect(totalPayouts).toBeCloseTo(
      totalWinnerDeposits + totalLoserDeposits,
      10
    );
  });

  test('default args (no pool context) returns cost basis', () => {
    // When called without totalWinnerShares/totalLoserDeposits
    const payout = PredictionPricing.calculateExpectedPayout(100, 0.6);
    expect(payout).toBe(60); // costBasis = 100 * 0.6
  });
});

// ─── Market Initialization ──────────────────────────────────────────────────

describe('initializeMarket', () => {
  test('default liquidity creates 50/50 market', () => {
    const market = PredictionPricing.initializeMarket();
    expect(market.yesShares).toBe(5000);
    expect(market.noShares).toBe(5000);
  });

  test('custom liquidity splits evenly', () => {
    const market = PredictionPricing.initializeMarket(20_000);
    expect(market.yesShares).toBe(10_000);
    expect(market.noShares).toBe(10_000);
  });

  test('initialized market has 50% price for both sides', () => {
    const market = PredictionPricing.initializeMarket(10_000);
    const yesPrice = PredictionPricing.getCurrentPrice(
      market.yesShares,
      market.noShares,
      'yes'
    );
    const noPrice = PredictionPricing.getCurrentPrice(
      market.yesShares,
      market.noShares,
      'no'
    );
    expect(yesPrice).toBe(0.5);
    expect(noPrice).toBe(0.5);
  });

  test('supports explicit non-neutral initialization when requested', () => {
    const market = PredictionPricing.initializeMarket(10_000, 0.55);
    const yesPrice = PredictionPricing.getCurrentPrice(
      market.yesShares,
      market.noShares,
      'yes'
    );
    const noPrice = PredictionPricing.getCurrentPrice(
      market.yesShares,
      market.noShares,
      'no'
    );
    expect(yesPrice).toBeCloseTo(0.55, 10);
    expect(noPrice).toBeCloseTo(0.45, 10);
  });

  test('clamps extreme initialization probabilities into safe bounds', () => {
    const low = PredictionPricing.initializeMarket(10_000, 0.01);
    const high = PredictionPricing.initializeMarket(10_000, 0.99);

    expect(
      PredictionPricing.getCurrentPrice(low.yesShares, low.noShares, 'yes')
    ).toBeCloseTo(0.05, 10);
    expect(
      PredictionPricing.getCurrentPrice(high.yesShares, high.noShares, 'yes')
    ).toBeCloseTo(0.95, 10);
  });
});

// ─── getCurrentPrice ────────────────────────────────────────────────────────

describe('getCurrentPrice', () => {
  test('50/50 market: both sides at 0.5', () => {
    expect(PredictionPricing.getCurrentPrice(500, 500, 'yes')).toBe(0.5);
    expect(PredictionPricing.getCurrentPrice(500, 500, 'no')).toBe(0.5);
  });

  test('skewed 80/20: YES cheap at 0.20, NO expensive at 0.80', () => {
    // YES price = noShares / total = 2000 / 10000 = 0.20
    const yesPrice = PredictionPricing.getCurrentPrice(8000, 2000, 'yes');
    expect(yesPrice).toBe(0.2);
    const noPrice = PredictionPricing.getCurrentPrice(8000, 2000, 'no');
    expect(noPrice).toBe(0.8);
  });

  test('prices always sum to 1.0', () => {
    for (const [y, n] of [
      [100, 900],
      [500, 500],
      [1, 99999],
      [7777, 3333],
    ] as const) {
      const yes = PredictionPricing.getCurrentPrice(y, n, 'yes');
      const no = PredictionPricing.getCurrentPrice(y, n, 'no');
      expect(yes + no).toBeCloseTo(1.0, 10);
    }
  });

  test('zero total returns 0.5 (default)', () => {
    expect(PredictionPricing.getCurrentPrice(0, 0, 'yes')).toBe(0.5);
    expect(PredictionPricing.getCurrentPrice(0, 0, 'no')).toBe(0.5);
  });

  test('price after buy reflects CPMM state', () => {
    // Buy YES in 50/50 market, then check getCurrentPrice matches
    const result = PredictionPricing.calculateBuy(5000, 5000, 'yes', 100);
    const yesPrice = PredictionPricing.getCurrentPrice(
      result.newYesShares,
      result.newNoShares,
      'yes'
    );
    // Should match the newYesPrice from calculateBuy
    expect(yesPrice).toBeCloseTo(result.newYesPrice, 10);
  });
});
