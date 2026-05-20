import { PredictionPricing } from '@feed/core/markets/prediction/client';
import {
  buildPredictionMarketProfile,
  getPredictionMarketLiquidityTier,
} from './prediction-market-profiles';

export interface SummaryStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p90: number;
}

export interface PredictionMarketDiagnosticInput {
  id: string;
  question: string;
  yesShares: number;
  noShares: number;
  liquidity: number;
  endDate: Date;
}

export interface PredictionHistoryPoint {
  marketId: string;
  yesPrice: number;
  createdAt: Date;
}

export interface PredictionRealismMetrics {
  activeMarkets: number;
  yesPriceDispersion: SummaryStats | null;
  distanceFromMid: SummaryStats | null;
  priceChange24h: SummaryStats | null;
  nearMidCount: number;
  extremeCount: number;
  horizonBuckets: Record<'short' | 'medium' | 'long', number>;
  urgencyLevels: Record<'imminent' | 'near-term' | 'dated', number>;
  eventSensitivity: Record<'low' | 'medium' | 'high', number>;
  liquidityTiers: Record<'thin' | 'balanced' | 'deep', number>;
  warnings: string[];
}

export interface PerpRealismMetrics {
  activeMarkets: number;
  quoteCoverageRate: number;
  invalidQuoteRate: number;
  spreadBps: SummaryStats | null;
  bidDepth: SummaryStats | null;
  askDepth: SummaryStats | null;
  depthRatioByOrderSize: Record<string, SummaryStats | null>;
  liquidityRegimes: Record<'thin' | 'balanced' | 'deep', number>;
  staleQuotesCount: number;
  invalidQuoteCount: number;
  invalidCurrentPriceCount: number;
  warnings: string[];
}

export interface PerpRealismDiagnosticInput {
  ticker: string;
  openInterest: number;
  volume24h: number;
  currentPrice?: number;
  bidPrice?: number;
  askPrice?: number;
  spreadBps?: number;
  bidDepth?: number;
  askDepth?: number;
  liquidityRegime?: 'thin' | 'balanced' | 'deep';
  quoteUpdatedAt?: Date;
}

function sorted(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function percentile(values: number[], q: number): number {
  const ordered = sorted(values);
  if (ordered.length === 0) return 0;
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(q * ordered.length) - 1)
  );
  return ordered[index] ?? 0;
}

export function summarizeSeries(values: number[]): SummaryStats | null {
  if (values.length === 0) return null;
  const ordered = sorted(values);
  const count = ordered.length;
  const sum = ordered.reduce((acc, value) => acc + value, 0);
  const median =
    count % 2 === 0
      ? ((ordered[count / 2 - 1] ?? 0) + (ordered[count / 2] ?? 0)) / 2
      : (ordered[Math.floor(count / 2)] ?? 0);

  return {
    count,
    min: ordered[0] ?? 0,
    max: ordered[count - 1] ?? 0,
    mean: sum / count,
    median,
    p90: percentile(ordered, 0.9),
  };
}

function zeroCounts<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

export function computePredictionRealismMetrics(params: {
  markets: PredictionMarketDiagnosticInput[];
  priceHistory: PredictionHistoryPoint[];
  now?: Date;
}): PredictionRealismMetrics {
  const now = params.now ?? new Date();
  const horizonBuckets = zeroCounts(['short', 'medium', 'long'] as const);
  const urgencyLevels = zeroCounts(['imminent', 'near-term', 'dated'] as const);
  const eventSensitivity = zeroCounts(['low', 'medium', 'high'] as const);
  const liquidityTiers = zeroCounts(['thin', 'balanced', 'deep'] as const);

  const yesPrices: number[] = [];
  const distanceFromMid: number[] = [];

  for (const market of params.markets) {
    const yesPrice = PredictionPricing.getCurrentPrice(
      market.yesShares,
      market.noShares,
      'yes'
    );
    const profile = buildPredictionMarketProfile({
      marketId: market.id,
      question: market.question,
      endDate: market.endDate,
      now,
    });

    horizonBuckets[profile.horizonBucket]++;
    urgencyLevels[profile.urgencyLevel]++;
    eventSensitivity[profile.eventSensitivity]++;
    liquidityTiers[getPredictionMarketLiquidityTier(market.liquidity)]++;
    yesPrices.push(yesPrice);
    distanceFromMid.push(Math.abs(yesPrice - 0.5));
  }

  const nearMidCount = yesPrices.filter(
    (price) => Math.abs(price - 0.5) <= 0.05
  ).length;
  const extremeCount = yesPrices.filter(
    (price) => price <= 0.2 || price >= 0.8
  ).length;

  const activeMarketIds = new Set(params.markets.map((market) => market.id));
  const historyByMarket = new Map<string, PredictionHistoryPoint[]>();
  for (const point of params.priceHistory) {
    if (!activeMarketIds.has(point.marketId)) continue;
    const existing = historyByMarket.get(point.marketId) ?? [];
    existing.push(point);
    historyByMarket.set(point.marketId, existing);
  }

  const marketPriceChange24h = Array.from(historyByMarket.entries())
    .map(([, points]) => {
      const ordered = [...points].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
      );
      const first = ordered[0];
      const last = ordered[ordered.length - 1];
      if (
        !first ||
        !last ||
        first.createdAt.getTime() === last.createdAt.getTime()
      ) {
        return null;
      }
      return Math.abs(last.yesPrice - first.yesPrice);
    })
    .filter((value): value is number => value !== null);

  const warnings: string[] = [];
  const yesPriceSummary = summarizeSeries(yesPrices);
  const distanceSummary = summarizeSeries(distanceFromMid);
  const priceChangeSummary = summarizeSeries(marketPriceChange24h);

  if (yesPriceSummary && yesPriceSummary.max - yesPriceSummary.min < 0.15) {
    warnings.push(
      'Prediction price dispersion is narrow; markets may still feel too similar.'
    );
  }

  if (params.markets.length > 0 && nearMidCount / params.markets.length > 0.7) {
    warnings.push(
      'Most prediction markets are clustered near 50/50; consider stronger profile/event differentiation.'
    );
  }

  if (Object.values(eventSensitivity).every((count) => count === 0)) {
    warnings.push(
      'Prediction event sensitivity buckets are unexpectedly empty.'
    );
  }

  return {
    activeMarkets: params.markets.length,
    yesPriceDispersion: yesPriceSummary,
    distanceFromMid: distanceSummary,
    priceChange24h: priceChangeSummary,
    nearMidCount,
    extremeCount,
    horizonBuckets,
    urgencyLevels,
    eventSensitivity,
    liquidityTiers,
    warnings,
  };
}

export function computePerpRealismMetrics(params: {
  markets: PerpRealismDiagnosticInput[];
  now?: Date;
  sampleOrderSizes?: number[];
}): PerpRealismMetrics {
  const now = params.now ?? new Date();
  const sampleOrderSizes = params.sampleOrderSizes ?? [1000, 5000];
  const liquidityRegimes = zeroCounts(['thin', 'balanced', 'deep'] as const);

  const validQuotedMarkets = params.markets.filter((market) => {
    const bidPrice = market.bidPrice;
    const askPrice = market.askPrice;
    const spreadBps = market.spreadBps;
    const bidDepth = market.bidDepth;
    const askDepth = market.askDepth;

    return (
      bidPrice !== undefined &&
      askPrice !== undefined &&
      spreadBps !== undefined &&
      bidDepth !== undefined &&
      askDepth !== undefined &&
      Number.isFinite(bidPrice) &&
      Number.isFinite(askPrice) &&
      Number.isFinite(spreadBps) &&
      Number.isFinite(bidDepth) &&
      Number.isFinite(askDepth) &&
      bidPrice > 0 &&
      askPrice >= bidPrice &&
      spreadBps >= 0 &&
      bidDepth > 0 &&
      askDepth > 0
    );
  });

  const coveredMarkets = params.markets.filter(
    (market) =>
      market.bidPrice !== undefined &&
      market.askPrice !== undefined &&
      market.spreadBps !== undefined &&
      market.bidDepth !== undefined &&
      market.askDepth !== undefined
  );

  const spreads = coveredMarkets
    .map((market) => market.spreadBps)
    .filter((value): value is number => typeof value === 'number');
  const bidDepths = coveredMarkets
    .map((market) => market.bidDepth)
    .filter((value): value is number => typeof value === 'number');
  const askDepths = coveredMarkets
    .map((market) => market.askDepth)
    .filter((value): value is number => typeof value === 'number');

  let staleQuotesCount = 0;
  let invalidCurrentPriceCount = 0;
  for (const market of params.markets) {
    const regime = market.liquidityRegime ?? 'thin';
    liquidityRegimes[regime]++;
    if (
      market.currentPrice === undefined ||
      !Number.isFinite(market.currentPrice) ||
      market.currentPrice <= 0
    ) {
      invalidCurrentPriceCount++;
    }
    if (
      market.quoteUpdatedAt &&
      now.getTime() - market.quoteUpdatedAt.getTime() > 30 * 60 * 1000
    ) {
      staleQuotesCount++;
    }
  }

  const invalidQuoteCount = Math.max(
    0,
    coveredMarkets.length - validQuotedMarkets.length
  );

  const depthRatioByOrderSize = Object.fromEntries(
    sampleOrderSizes.map((size) => [
      String(size),
      summarizeSeries(
        validQuotedMarkets.map(
          (market) => size / Math.max(market.askDepth ?? 1, 1)
        )
      ),
    ])
  ) as Record<string, SummaryStats | null>;

  const warnings: string[] = [];
  const spreadSummary = summarizeSeries(spreads);

  if (
    params.markets.length > 0 &&
    coveredMarkets.length !== params.markets.length
  ) {
    warnings.push('Some perp markets are missing quote-state fields.');
  }

  if (invalidQuoteCount > 0) {
    warnings.push(
      `${invalidQuoteCount} perp markets have invalid quote-state structure (e.g. ask < bid or non-positive depth).`
    );
  }

  if (spreadSummary && spreadSummary.max - spreadSummary.min < 10) {
    warnings.push(
      'Perp spread dispersion is narrow; market personalities may still be too uniform.'
    );
  }

  if (staleQuotesCount > 0) {
    warnings.push(
      `${staleQuotesCount} perp markets have stale quote timestamps.`
    );
  }

  if (invalidCurrentPriceCount > 0) {
    warnings.push(
      `${invalidCurrentPriceCount} perp markets have invalid canonical currentPrice values.`
    );
  }

  return {
    activeMarkets: params.markets.length,
    quoteCoverageRate:
      params.markets.length > 0
        ? coveredMarkets.length / params.markets.length
        : 0,
    invalidQuoteRate:
      params.markets.length > 0 ? invalidQuoteCount / params.markets.length : 0,
    spreadBps: spreadSummary,
    bidDepth: summarizeSeries(bidDepths),
    askDepth: summarizeSeries(askDepths),
    depthRatioByOrderSize,
    liquidityRegimes,
    staleQuotesCount,
    invalidQuoteCount,
    invalidCurrentPriceCount,
    warnings,
  };
}
