import { describe, expect, it } from 'bun:test';
import {
  computePerpRealismMetrics,
  computePredictionRealismMetrics,
  summarizeSeries,
} from './market-realism-metrics';

describe('market-realism-metrics', () => {
  it('summarizes numeric series deterministically', () => {
    expect(summarizeSeries([1, 2, 3, 4, 5])).toEqual({
      count: 5,
      min: 1,
      max: 5,
      mean: 3,
      median: 3,
      p90: 5,
    });
  });

  it('flags narrow prediction price dispersion', () => {
    const metrics = computePredictionRealismMetrics({
      markets: [
        {
          id: 'm1',
          question: 'Will OpenAGI publish a roadmap?',
          yesShares: 5200,
          noShares: 4800,
          liquidity: 18_000,
          endDate: new Date('2026-04-05T00:00:00.000Z'),
        },
        {
          id: 'm2',
          question: 'Will AINBC post an earnings recap?',
          yesShares: 5100,
          noShares: 4900,
          liquidity: 19_000,
          endDate: new Date('2026-04-06T00:00:00.000Z'),
        },
      ],
      priceHistory: [],
      now: new Date('2026-04-02T00:00:00.000Z'),
    });

    expect(metrics.warnings.length).toBeGreaterThan(0);
  });

  it('ignores prediction history for markets outside the active market set', () => {
    const metrics = computePredictionRealismMetrics({
      markets: [
        {
          id: 'active-market',
          question: 'Will OpenAGI publish a roadmap?',
          yesShares: 5200,
          noShares: 4800,
          liquidity: 18_000,
          endDate: new Date('2026-04-05T00:00:00.000Z'),
        },
      ],
      priceHistory: [
        {
          marketId: 'active-market',
          yesPrice: 0.4,
          createdAt: new Date('2026-04-01T00:00:00.000Z'),
        },
        {
          marketId: 'active-market',
          yesPrice: 0.6,
          createdAt: new Date('2026-04-02T00:00:00.000Z'),
        },
        {
          marketId: 'resolved-market',
          yesPrice: 0.01,
          createdAt: new Date('2026-04-01T00:00:00.000Z'),
        },
        {
          marketId: 'resolved-market',
          yesPrice: 0.99,
          createdAt: new Date('2026-04-02T00:00:00.000Z'),
        },
      ],
      now: new Date('2026-04-02T00:00:00.000Z'),
    });

    expect(metrics.priceChange24h?.max).toBeCloseTo(0.2, 10);
  });

  it('reports perp quote coverage and impact by size', () => {
    const metrics = computePerpRealismMetrics({
      markets: [
        {
          ticker: 'OPENAGI',
          currentPrice: 100,
          volume24h: 50_000,
          openInterest: 20_000,
          bidPrice: 99.5,
          askPrice: 100.5,
          spreadBps: 100,
          bidDepth: 1000,
          askDepth: 1000,
          liquidityRegime: 'balanced',
          quoteUpdatedAt: new Date('2026-04-02T00:00:00.000Z'),
        },
      ],
      now: new Date('2026-04-02T00:10:00.000Z'),
      sampleOrderSizes: [1000],
    });

    expect(metrics.quoteCoverageRate).toBe(1);
    expect(metrics.invalidQuoteRate).toBe(0);
    expect(metrics.depthRatioByOrderSize['1000']?.mean).toBeGreaterThan(0);
  });

  it('flags invalid perp quotes and invalid canonical currentPrice values', () => {
    const metrics = computePerpRealismMetrics({
      markets: [
        {
          ticker: 'BROKEN',
          currentPrice: 0,
          volume24h: 10_000,
          openInterest: 500,
          bidPrice: 100,
          askPrice: 99,
          spreadBps: 80,
          bidDepth: 0,
          askDepth: 1000,
          liquidityRegime: 'thin',
          quoteUpdatedAt: new Date('2026-04-02T00:00:00.000Z'),
        },
      ],
      now: new Date('2026-04-02T00:10:00.000Z'),
      sampleOrderSizes: [1000],
    });

    expect(metrics.quoteCoverageRate).toBe(1);
    expect(metrics.invalidQuoteCount).toBe(1);
    expect(metrics.invalidQuoteRate).toBe(1);
    expect(metrics.invalidCurrentPriceCount).toBe(1);
    expect(metrics.warnings).toContain(
      '1 perp markets have invalid quote-state structure (e.g. ask < bid or non-positive depth).'
    );
    expect(metrics.warnings).toContain(
      '1 perp markets have invalid canonical currentPrice values.'
    );
  });
});
