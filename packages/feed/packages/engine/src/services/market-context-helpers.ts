import type { PerpMarketRecord } from '@feed/core/markets/perps';
import {
  maxSafeBuy,
  type PredictionMarketRecord,
  PredictionPricing,
} from '@feed/core/markets/prediction/client';
import type {
  PerpMarketSnapshot,
  PredictionMarketSnapshot,
} from '../types/market-context';
import {
  buildPredictionMarketProfile,
  getPredictionMarketLiquidityTier,
} from './prediction-market-profiles';

export const MAX_MARKET_QUESTION_LENGTH = 120;

function truncateQuestion(question: string, maxQuestionLength: number): string {
  return question.length > maxQuestionLength
    ? question.slice(0, maxQuestionLength) + '...'
    : question;
}

export function buildPerpMarketSnapshot(
  market: PerpMarketRecord
): PerpMarketSnapshot {
  return {
    ticker: market.ticker,
    organizationId: market.organizationId,
    name: market.name ?? market.ticker,
    currentPrice: market.currentPrice,
    change24h: market.change24h,
    changePercent24h: market.changePercent24h,
    high24h: market.high24h,
    low24h: market.low24h,
    volume24h: market.volume24h,
    openInterest: market.openInterest,
  };
}

export function buildPredictionMarketSnapshot(
  market: Pick<
    PredictionMarketRecord,
    'id' | 'question' | 'yesShares' | 'noShares' | 'liquidity' | 'endDate'
  >,
  now: Date = new Date(),
  options?: {
    maxQuestionLength?: number;
  }
): PredictionMarketSnapshot {
  const profile = buildPredictionMarketProfile({
    marketId: market.id,
    question: market.question,
    endDate: market.endDate,
    now,
  });
  const yesPrice =
    PredictionPricing.getCurrentPrice(
      market.yesShares,
      market.noShares,
      'yes'
    ) * 100;
  const noPrice =
    PredictionPricing.getCurrentPrice(market.yesShares, market.noShares, 'no') *
    100;
  const daysUntilResolution = Math.max(
    0,
    Math.ceil(
      (market.endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    )
  );

  return {
    id: market.id,
    text:
      typeof options?.maxQuestionLength === 'number'
        ? truncateQuestion(market.question, options.maxQuestionLength)
        : market.question,
    yesPrice,
    noPrice,
    // Liquidity is the most stable canonical depth metric we currently have.
    totalVolume: market.liquidity,
    resolutionDate: market.endDate.toISOString(),
    daysUntilResolution,
    horizonBucket: profile.horizonBucket,
    liquidityTier: getPredictionMarketLiquidityTier(market.liquidity),
    urgencyLevel: profile.urgencyLevel,
    eventSensitivity: profile.eventSensitivity,
    // Max safe single-trade size given current pool depth and 20ppt slippage cap.
    maxSafeBet: maxSafeBuy(market.yesShares, market.noShares),
  };
}
