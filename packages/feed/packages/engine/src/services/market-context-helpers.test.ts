import { describe, expect, it } from 'bun:test';
import { maxSafeBuy } from '@babylon/core/markets/prediction/client';
import {
  buildPerpMarketSnapshot,
  buildPredictionMarketSnapshot,
  MAX_MARKET_QUESTION_LENGTH,
} from './market-context-helpers';

describe('market-context-helpers', () => {
  it('maps perp market records without altering canonical fields', () => {
    const snapshot = buildPerpMarketSnapshot({
      ticker: 'OPENAGI',
      organizationId: 'openagi',
      name: 'OpenAGI',
      currentPrice: 123.45,
      price24hAgo: 120,
      change24h: 3.45,
      changePercent24h: 2.875,
      high24h: 130,
      low24h: 118,
      volume24h: 500000,
      openInterest: 250000,
      fundingRate: {
        ticker: 'OPENAGI',
        rate: 0.01,
        nextFundingTime: new Date().toISOString(),
        predictedRate: 0.01,
      },
      maxLeverage: 100,
      minOrderSize: 10,
      markPrice: 123.5,
      indexPrice: 123.4,
    });

    expect(snapshot).toEqual({
      ticker: 'OPENAGI',
      organizationId: 'openagi',
      name: 'OpenAGI',
      currentPrice: 123.45,
      change24h: 3.45,
      changePercent24h: 2.875,
      high24h: 130,
      low24h: 118,
      volume24h: 500000,
      openInterest: 250000,
    });
  });

  it('uses CPMM pricing semantics for prediction YES/NO probabilities', () => {
    const snapshot = buildPredictionMarketSnapshot(
      {
        id: 'market-1',
        question: 'Will OpenAGI ship AGI before year-end?',
        yesShares: 60,
        noShares: 40,
        liquidity: 20000,
        endDate: new Date('2026-04-05T12:00:00.000Z'),
      },
      new Date('2026-04-01T12:00:00.000Z')
    );

    expect(snapshot.yesPrice).toBe(40);
    expect(snapshot.noPrice).toBe(60);
    expect(snapshot.totalVolume).toBe(20000);
    expect(snapshot.daysUntilResolution).toBe(4);
    expect(snapshot.horizonBucket).toBe('medium');
    expect(snapshot.liquidityTier).toBe('balanced');
    expect(snapshot.urgencyLevel).toBe('near-term');
    expect(snapshot.eventSensitivity).toBe('high');
  });

  it('truncates long prediction questions for token discipline', () => {
    const longQuestion = 'Q'.repeat(MAX_MARKET_QUESTION_LENGTH + 20);
    const snapshot = buildPredictionMarketSnapshot(
      {
        id: 'market-2',
        question: longQuestion,
        yesShares: 50,
        noShares: 50,
        liquidity: 1000,
        endDate: new Date('2026-04-05T12:00:00.000Z'),
      },
      undefined,
      { maxQuestionLength: MAX_MARKET_QUESTION_LENGTH }
    );

    expect(snapshot.text.length).toBe(MAX_MARKET_QUESTION_LENGTH + 3);
    expect(snapshot.text.endsWith('...')).toBe(true);
  });

  it('preserves full question text when no truncation policy is provided', () => {
    const longQuestion = 'Q'.repeat(MAX_MARKET_QUESTION_LENGTH + 20);
    const snapshot = buildPredictionMarketSnapshot({
      id: 'market-3',
      question: longQuestion,
      yesShares: 50,
      noShares: 50,
      liquidity: 1000,
      endDate: new Date('2026-04-05T12:00:00.000Z'),
    });

    expect(snapshot.text).toBe(longQuestion);
  });

  it('exposes maxSafeBet derived from pool depth', () => {
    // Balanced $10k pool: maxSafeBet ≈ $2,460 net / 0.99 ≈ $2,484 gross
    const snapshot = buildPredictionMarketSnapshot({
      id: 'market-4',
      question: 'Will X happen?',
      yesShares: 5000,
      noShares: 5000,
      liquidity: 10000,
      endDate: new Date('2026-05-01T00:00:00.000Z'),
    });

    expect(snapshot.maxSafeBet).toBeGreaterThan(2000);
    expect(snapshot.maxSafeBet).toBeLessThan(3000);
  });

  it('maxSafeBet is lower for skewed markets (minority side is constrained)', () => {
    // 80% YES market (Y=2000, N=8000) — NO buyers are binding constraint (~$1210)
    const snapshot80pct = buildPredictionMarketSnapshot({
      id: 'market-5',
      question: 'Will X happen?',
      yesShares: 2000,
      noShares: 8000,
      liquidity: 10000,
      endDate: new Date('2026-05-01T00:00:00.000Z'),
    });

    // Balanced market for comparison
    const snapshotBalanced = buildPredictionMarketSnapshot({
      id: 'market-6',
      question: 'Will X happen?',
      yesShares: 5000,
      noShares: 5000,
      liquidity: 10000,
      endDate: new Date('2026-05-01T00:00:00.000Z'),
    });

    // Skewed market should have lower maxSafeBet (constrained by NO side)
    expect(snapshot80pct.maxSafeBet).toBeLessThan(snapshotBalanced.maxSafeBet);
    expect(snapshot80pct.maxSafeBet).toBeGreaterThan(500);
    expect(snapshot80pct.maxSafeBet).toBeLessThan(1500);
  });

  it('maxSafeBet is zero or near-zero for illiquid markets', () => {
    const snapshotIlliquid = buildPredictionMarketSnapshot({
      id: 'market-7',
      question: 'Will X happen?',
      yesShares: 0,
      noShares: 0,
      liquidity: 0,
      endDate: new Date('2026-05-01T00:00:00.000Z'),
    });

    expect(snapshotIlliquid.maxSafeBet).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// maxSafeBuy unit tests
// ---------------------------------------------------------------------------
describe('maxSafeBuy — CPMM max trade formula', () => {
  it('balanced $10k pool: max gross ≈ $2,484', () => {
    const result = maxSafeBuy(5000, 5000);
    expect(result).toBeGreaterThanOrEqual(2400);
    expect(result).toBeLessThanOrEqual(2600);
  });

  it('larger pool allows proportionally larger trades', () => {
    const small = maxSafeBuy(5_000, 5_000); // $10k pool
    const large = maxSafeBuy(50_000, 50_000); // $100k pool
    expect(large).toBeGreaterThan(small * 8); // ~10× deeper → ~10× more
  });

  it('skewed 80% YES pool — NO buyers are the binding constraint', () => {
    // YES buyers have lots of room, NO buyers have little
    const maxBet = maxSafeBuy(2000, 8000);
    expect(maxBet).toBeGreaterThan(500);
    expect(maxBet).toBeLessThan(1500);
  });

  it('symmetric: same result for 80% NO pool (by symmetry)', () => {
    const max80Yes = maxSafeBuy(2000, 8000); // 80% YES market
    const max80No = maxSafeBuy(8000, 2000); // 20% YES (80% NO) market
    expect(max80Yes).toBe(max80No); // symmetric by design
  });

  it('zero pool returns zero', () => {
    expect(maxSafeBuy(0, 0)).toBe(0);
    expect(maxSafeBuy(0, 5000)).toBe(0);
  });

  it('result is always a non-negative integer', () => {
    const result = maxSafeBuy(3000, 7000);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result)).toBe(true);
  });
});
