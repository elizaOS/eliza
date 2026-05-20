// These unions intentionally mirror the shared leaderboard query contract.
// They stay local to the API package to keep service-layer types lightweight
// and avoid coupling them to shared validation implementation details.
export type LeaderboardMetric = 'reputation' | 'trading';
export type LeaderboardScope = 'wallet' | 'team';

export interface LeaderboardEntry {
  id: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  reputationPoints: number;
  balance: number;
  lifetimePnL: number;
  capitalBase?: number;
  effectiveCapitalBase?: number;
  tradingReturn?: number;
  createdAt: Date;
  rank: number;
  isAgent: boolean;
  managedBy?: string | null;
  nftTokenId: number | null;
  teamReputationPoints?: number;
  userReputationPoints?: number;
  agentReputationPoints?: number;
  teamLifetimePnL?: number;
  userLifetimePnL?: number;
  agentLifetimePnL?: number;
  teamCapitalBase?: number;
  teamEffectiveCapitalBase?: number;
  teamTradingReturn?: number;
  agentCount?: number;
}

export interface LeaderboardResult {
  users: LeaderboardEntry[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  leaderboardType: LeaderboardScope;
  leaderboardMetric: LeaderboardMetric;
}

export interface LeaderboardPosition {
  rank: number;
  page: number;
  entry: LeaderboardEntry;
}
