#!/usr/bin/env bun

import { parseArgs } from 'node:util';
import { db } from '@feed/db';
import {
  markets,
  perpMarketSnapshots,
  predictionPriceHistories,
} from '@feed/db/schema';
import { initializeDatabaseMode } from '@feed/engine';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import {
  computePerpRealismMetrics,
  computePredictionRealismMetrics,
  type SummaryStats,
} from '../packages/engine/src/services/market-realism-metrics';

const { values: args } = parseArgs({
  options: {
    json: { type: 'boolean', default: false },
    hours: { type: 'string', default: '24' },
  },
  strict: true,
});

const hours = Number.parseInt(args.hours ?? '24', 10);
if (!Number.isFinite(hours) || hours <= 0) {
  throw new Error('--hours must be a positive integer');
}

function formatStat(stat: SummaryStats | null, digits = 2): string {
  if (!stat) return 'n/a';
  return `min ${stat.min.toFixed(digits)} | p50 ${stat.median.toFixed(
    digits
  )} | mean ${stat.mean.toFixed(digits)} | p90 ${stat.p90.toFixed(
    digits
  )} | max ${stat.max.toFixed(digits)}`;
}

function formatBuckets(record: Record<string, number>): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}:${value}`)
    .join(' | ');
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is required to run market realism diagnostics.'
    );
  }

  initializeDatabaseMode();
  const now = new Date();
  const since = new Date(now.getTime() - hours * 60 * 60 * 1000);

  const predictionMarkets = await db
    .select({
      id: markets.id,
      question: markets.question,
      yesShares: markets.yesShares,
      noShares: markets.noShares,
      liquidity: markets.liquidity,
      endDate: markets.endDate,
    })
    .from(markets)
    .where(and(eq(markets.resolved, false), gte(markets.endDate, now)))
    .orderBy(desc(markets.createdAt));

  const activePredictionMarketIds = predictionMarkets.map(
    (market) => market.id
  );

  const predictionHistory =
    activePredictionMarketIds.length > 0
      ? await db
          .select({
            marketId: predictionPriceHistories.marketId,
            yesPrice: predictionPriceHistories.yesPrice,
            createdAt: predictionPriceHistories.createdAt,
          })
          .from(predictionPriceHistories)
          .where(
            and(
              gte(predictionPriceHistories.createdAt, since),
              inArray(
                predictionPriceHistories.marketId,
                activePredictionMarketIds
              )
            )
          )
          .orderBy(desc(predictionPriceHistories.createdAt))
      : [];

  const perpRows = await db
    .select({
      ticker: perpMarketSnapshots.ticker,
      currentPrice: perpMarketSnapshots.currentPrice,
      openInterest: perpMarketSnapshots.openInterest,
      volume24h: perpMarketSnapshots.volume24h,
      bidPrice: perpMarketSnapshots.bidPrice,
      askPrice: perpMarketSnapshots.askPrice,
      spreadBps: perpMarketSnapshots.spreadBps,
      bidDepth: perpMarketSnapshots.bidDepth,
      askDepth: perpMarketSnapshots.askDepth,
      liquidityRegime: perpMarketSnapshots.liquidityRegime,
      quoteUpdatedAt: perpMarketSnapshots.quoteUpdatedAt,
    })
    .from(perpMarketSnapshots)
    .orderBy(desc(perpMarketSnapshots.openInterest));

  const predictionMetrics = computePredictionRealismMetrics({
    markets: predictionMarkets.map((market) => ({
      id: market.id,
      question: market.question,
      yesShares: Number(market.yesShares),
      noShares: Number(market.noShares),
      liquidity: Number(market.liquidity),
      endDate: market.endDate,
    })),
    priceHistory: predictionHistory.map((point) => ({
      marketId: point.marketId,
      yesPrice: point.yesPrice,
      createdAt: point.createdAt,
    })),
    now,
  });

  const perpMetrics = computePerpRealismMetrics({
    markets: perpRows.map((row) => ({
      ticker: row.ticker,
      currentPrice: Number(row.currentPrice),
      openInterest: Number(row.openInterest),
      volume24h: Number(row.volume24h),
      bidPrice: row.bidPrice ? Number(row.bidPrice) : undefined,
      askPrice: row.askPrice ? Number(row.askPrice) : undefined,
      spreadBps: row.spreadBps ? Number(row.spreadBps) : undefined,
      bidDepth: row.bidDepth ? Number(row.bidDepth) : undefined,
      askDepth: row.askDepth ? Number(row.askDepth) : undefined,
      liquidityRegime:
        (row.liquidityRegime as 'thin' | 'balanced' | 'deep' | null) ??
        undefined,
      quoteUpdatedAt: row.quoteUpdatedAt ?? undefined,
    })),
    now,
  });

  const report = {
    generatedAt: now.toISOString(),
    windowHours: hours,
    predictions: predictionMetrics,
    perps: perpMetrics,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('Market Realism Report');
  console.log(`Generated: ${now.toISOString()}`);
  console.log(`Window: ${hours}h`);
  console.log('');

  console.log('Predictions');
  console.log(`- Active markets: ${predictionMetrics.activeMarkets}`);
  console.log(
    `- YES price dispersion: ${formatStat(predictionMetrics.yesPriceDispersion, 3)}`
  );
  console.log(
    `- Distance from 50/50: ${formatStat(predictionMetrics.distanceFromMid, 3)}`
  );
  console.log(
    `- 24h price change: ${formatStat(predictionMetrics.priceChange24h, 3)}`
  );
  console.log(
    `- Near 50/50: ${predictionMetrics.nearMidCount} | Extreme: ${predictionMetrics.extremeCount}`
  );
  console.log(`- Horizons: ${formatBuckets(predictionMetrics.horizonBuckets)}`);
  console.log(`- Urgency: ${formatBuckets(predictionMetrics.urgencyLevels)}`);
  console.log(
    `- Event sensitivity: ${formatBuckets(predictionMetrics.eventSensitivity)}`
  );
  console.log(
    `- Liquidity tiers: ${formatBuckets(predictionMetrics.liquidityTiers)}`
  );
  if (predictionMetrics.warnings.length > 0) {
    console.log('- Warnings:');
    for (const warning of predictionMetrics.warnings) {
      console.log(`  - ${warning}`);
    }
  }
  console.log('');

  console.log('Perps');
  console.log(`- Active markets: ${perpMetrics.activeMarkets}`);
  console.log(
    `- Quote coverage: ${(perpMetrics.quoteCoverageRate * 100).toFixed(1)}%`
  );
  console.log(
    `- Invalid quote states: ${perpMetrics.invalidQuoteCount} (${(
      perpMetrics.invalidQuoteRate * 100
    ).toFixed(1)}%)`
  );
  console.log(
    `- Invalid currentPrice values: ${perpMetrics.invalidCurrentPriceCount}`
  );
  console.log(`- Spread bps: ${formatStat(perpMetrics.spreadBps, 1)}`);
  console.log(`- Bid depth: ${formatStat(perpMetrics.bidDepth, 0)}`);
  console.log(`- Ask depth: ${formatStat(perpMetrics.askDepth, 0)}`);
  console.log(
    `- Liquidity regimes: ${formatBuckets(perpMetrics.liquidityRegimes)}`
  );
  console.log(`- Stale quotes: ${perpMetrics.staleQuotesCount}`);
  for (const [size, stats] of Object.entries(
    perpMetrics.depthRatioByOrderSize
  )) {
    console.log(`- Size/depth ratio @ ${size}: ${formatStat(stats, 2)}`);
  }
  if (perpMetrics.warnings.length > 0) {
    console.log('- Warnings:');
    for (const warning of perpMetrics.warnings) {
      console.log(`  - ${warning}`);
    }
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Market realism report failed: ${message}`);
  process.exitCode = 1;
});
