export type UserPositionsType = 'all' | 'perp' | 'prediction';
export type UserPositionsStatus = 'open' | 'closed' | 'all';

export interface UserPerpPositionSnapshot {
  id: string;
  marketId?: string;
  ticker: string;
  side: 'long' | 'short';
  entryPrice: number;
  currentPrice: number;
  size: number;
  leverage: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  liquidationPrice: number;
  fundingPaid: number;
  realizedPnL: number;
  openedAt: string;
  closedAt: string | null;
  isAgentPosition: boolean;
  agentId: string | null;
  agentName: string | null;
}

export interface UserPredictionPositionSnapshot {
  id: string;
  marketId: string;
  question: string;
  side: 'YES' | 'NO';
  shares: number;
  avgPrice: number;
  currentPrice: number;
  currentProbability: number;
  currentValue: number;
  costBasis: number;
  unrealizedPnL: number;
  resolved: boolean;
  resolution: boolean | null;
  closesAt: string | null;
  status: string;
  createdAt: string | null;
  outcome: boolean | string | null;
  pnl: number | null;
  resolvedAt: string | null;
  isAgentPosition: boolean;
  agentId: string | null;
  agentName: string | null;
}

export interface UserPositionsSnapshot {
  perpetuals: {
    positions: UserPerpPositionSnapshot[];
    stats: {
      totalPositions: number;
      totalPnL: number;
      totalFunding: number;
    };
    total: number;
    hasMore: boolean;
  };
  predictions: {
    positions: UserPredictionPositionSnapshot[];
    stats: {
      totalPositions: number;
    };
    total: number;
    hasMore: boolean;
  };
  timestamp: string;
}

export function isOpenPredictionPosition(position: {
  resolved?: boolean;
  status?: string;
}) {
  return position.resolved === false && position.status === 'active';
}
