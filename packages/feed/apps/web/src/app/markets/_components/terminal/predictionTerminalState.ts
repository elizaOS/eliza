import type {
  PredictionResolutionSSE,
  PredictionTradeSSE,
} from '@/hooks/usePredictionMarketStream';
import type { PredictionMarket } from '@/types/markets';

export interface PredictionMarketTerminalState extends PredictionMarket {
  liquidity?: number;
  resolved?: boolean;
  resolution?: boolean | null;
  yesProbability?: number;
  noProbability?: number;
}

export interface PredictionMarketLiveState {
  marketId: string;
  yesShares: number;
  noShares: number;
  liquidity?: number;
  yesProbability: number;
  noProbability: number;
  resolved?: boolean;
  resolution?: boolean | null;
}

export function buildPredictionTerminalState(
  base: PredictionMarket | null,
  live: PredictionMarketLiveState | null
): PredictionMarketTerminalState | null {
  if (!base) {
    return null;
  }

  if (!live || live.marketId !== base.id.toString()) {
    return base as PredictionMarketTerminalState;
  }

  return {
    ...base,
    yesShares: live.yesShares,
    noShares: live.noShares,
    liquidity: live.liquidity,
    yesProbability: live.yesProbability,
    noProbability: live.noProbability,
    resolved: live.resolved ?? base.status === 'resolved',
    resolution: live.resolution ?? base.resolvedOutcome,
  };
}

export function buildPredictionLiveStateFromTrade(
  event: PredictionTradeSSE,
  previous?: PredictionMarketLiveState | null
): PredictionMarketLiveState {
  return {
    marketId: event.marketId,
    yesShares: event.yesShares,
    noShares: event.noShares,
    liquidity:
      event.liquidity ??
      (previous?.marketId === event.marketId ? previous.liquidity : undefined),
    yesProbability: event.yesPrice,
    noProbability: event.noPrice,
  };
}

export function buildPredictionLiveStateFromResolution(
  event: PredictionResolutionSSE,
  previous?: PredictionMarketLiveState | null
): PredictionMarketLiveState {
  return {
    marketId: event.marketId,
    yesShares: event.yesShares,
    noShares: event.noShares,
    liquidity:
      event.liquidity ??
      (previous?.marketId === event.marketId ? previous.liquidity : undefined),
    yesProbability: event.yesPrice,
    noProbability: event.noPrice,
    resolved: true,
    resolution: event.winningSide === 'yes',
  };
}

export function isSamePredictionLiveState(
  left: PredictionMarketLiveState | null,
  right: PredictionMarketLiveState | null
): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.marketId === right.marketId &&
    left.yesShares === right.yesShares &&
    left.noShares === right.noShares &&
    left.liquidity === right.liquidity &&
    left.yesProbability === right.yesProbability &&
    left.noProbability === right.noProbability &&
    left.resolved === right.resolved &&
    left.resolution === right.resolution
  );
}
