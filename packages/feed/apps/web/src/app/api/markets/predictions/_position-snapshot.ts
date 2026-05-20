import {
  calculatePredictionPositionSnapshot,
  type PredictionMarketRecord,
  type PredictionPositionRecord,
} from '@babylon/core/markets/prediction';
import { FEE_CONFIG } from '@babylon/engine';

export interface PredictionUserPositionSnapshot {
  id: string;
  marketId: string;
  side: 'YES' | 'NO';
  shares: number;
  avgPrice: number;
  currentPrice: number;
  currentProbability: number;
  currentValue: number;
  costBasis: number;
  unrealizedPnL: number;
  maxPayout: number;
  resolved: boolean;
  resolution: boolean | null;
}

export function buildPredictionUserPositionSnapshot(
  position: PredictionPositionRecord,
  market: PredictionMarketRecord
): PredictionUserPositionSnapshot | null {
  if (position.shares < 0.01) {
    return null;
  }

  const snapshot = calculatePredictionPositionSnapshot({
    shares: position.shares,
    avgPrice: position.avgPrice,
    side: position.side,
    yesShares: market.yesShares,
    noShares: market.noShares,
    feeRate: FEE_CONFIG.TRADING_FEE_RATE,
    resolved: market.resolved,
    resolution: market.resolution,
  });

  return {
    id: position.id,
    marketId: position.marketId,
    side: position.side === 'yes' ? 'YES' : 'NO',
    shares: position.shares,
    avgPrice: position.avgPrice,
    currentPrice: snapshot.currentUnitPrice,
    currentProbability: snapshot.currentProbability,
    currentValue: snapshot.currentValue,
    costBasis: snapshot.costBasis,
    unrealizedPnL: snapshot.unrealizedPnL,
    maxPayout: position.shares * (1 + position.avgPrice),
    resolved: market.resolved,
    resolution: market.resolution ?? null,
  };
}
