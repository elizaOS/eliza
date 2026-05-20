import { and, count, db, eq, users } from '@babylon/db';
import type {
  LeaderboardEntry,
  LeaderboardPosition,
  LeaderboardResult,
  LeaderboardScope,
} from './leaderboard-types';
import {
  type TeamTradingPerformanceRow,
  TradingPerformanceService,
  type WalletTradingPerformanceRow,
} from './trading-performance-service';

function mapWalletEntry(
  row: WalletTradingPerformanceRow,
  rank: number
): LeaderboardEntry {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    profileImageUrl: row.profileImageUrl,
    reputationPoints: Number(row.reputationPoints ?? 0),
    balance: Number(row.balance ?? 0),
    lifetimePnL: Number(row.lifetimePnL ?? 0),
    capitalBase: Number(row.capitalBase ?? 0),
    effectiveCapitalBase: Number(row.effectiveCapitalBase ?? 0),
    tradingReturn: Number(row.tradingReturn ?? 0),
    createdAt: new Date(row.createdAt),
    rank,
    isAgent: row.isAgent,
    managedBy: row.managedBy,
    nftTokenId: row.nftTokenId,
  };
}

function mapTeamEntry(
  row: TeamTradingPerformanceRow,
  rank: number
): LeaderboardEntry {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    profileImageUrl: row.profileImageUrl,
    reputationPoints: Number(row.reputationPoints ?? 0),
    balance: Number(row.balance ?? 0),
    lifetimePnL: Number(row.userLifetimePnL ?? 0),
    capitalBase: Number(row.teamCapitalBase ?? 0),
    effectiveCapitalBase: Number(row.teamEffectiveCapitalBase ?? 0),
    tradingReturn: Number(row.teamTradingReturn ?? 0),
    userLifetimePnL: Number(row.userLifetimePnL ?? 0),
    agentLifetimePnL: Number(row.agentLifetimePnL ?? 0),
    teamLifetimePnL: Number(row.teamLifetimePnL ?? 0),
    teamCapitalBase: Number(row.teamCapitalBase ?? 0),
    teamEffectiveCapitalBase: Number(row.teamEffectiveCapitalBase ?? 0),
    teamTradingReturn: Number(row.teamTradingReturn ?? 0),
    createdAt: new Date(row.createdAt),
    rank,
    isAgent: false,
    nftTokenId: row.nftTokenId,
    agentCount: row.agentCount ?? 0,
  };
}

export class TradingLeaderboardService {
  static async getWalletLeaderboard(
    page = 1,
    pageSize = 100
  ): Promise<LeaderboardResult> {
    const skip = (page - 1) * pageSize;

    const [countRows, rows] = await Promise.all([
      db.select({ count: count() }).from(users).where(eq(users.isActor, false)),
      TradingPerformanceService.getWalletLeaderboardRows(pageSize, skip),
    ]);

    const usersWithRank = rows.map((row, index) =>
      mapWalletEntry(row, skip + index + 1)
    );

    const totalCount = Number(countRows[0]?.count ?? 0);
    return {
      users: usersWithRank,
      totalCount,
      page,
      pageSize,
      totalPages: Math.ceil(totalCount / pageSize),
      leaderboardType: 'wallet',
      leaderboardMetric: 'trading',
    };
  }

  static async getTeamLeaderboard(
    page = 1,
    pageSize = 100
  ): Promise<LeaderboardResult> {
    const skip = (page - 1) * pageSize;

    const [countRows, rows] = await Promise.all([
      db
        .select({ count: count() })
        .from(users)
        .where(and(eq(users.isActor, false), eq(users.isAgent, false))),
      TradingPerformanceService.getTeamLeaderboardRows(pageSize, skip),
    ]);

    const usersWithRank = rows.map((row, index) =>
      mapTeamEntry(row, skip + index + 1)
    );

    const totalCount = Number(countRows[0]?.count ?? 0);
    return {
      users: usersWithRank,
      totalCount,
      page,
      pageSize,
      totalPages: Math.ceil(totalCount / pageSize),
      leaderboardType: 'team',
      leaderboardMetric: 'trading',
    };
  }

  static async getUserPosition(
    userId: string,
    leaderboardType: LeaderboardScope,
    pageSize = 100
  ): Promise<LeaderboardPosition | null> {
    const [user] = await db
      .select({
        id: users.id,
        isAgent: users.isAgent,
        managedBy: users.managedBy,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) return null;

    const effectiveUserId =
      leaderboardType === 'team' && user.isAgent && user.managedBy
        ? user.managedBy
        : user.id;

    if (leaderboardType === 'wallet') {
      const row =
        await TradingPerformanceService.getWalletEntry(effectiveUserId);
      if (!row) return null;

      const higherCount = await TradingPerformanceService.countWalletsAbove({
        id: row.id,
        createdAt: row.createdAt,
        tradingReturn: row.tradingReturn,
      });

      const rank = higherCount + 1;
      return {
        rank,
        page: Math.ceil(rank / pageSize),
        entry: mapWalletEntry(row, rank),
      };
    }

    const row = await TradingPerformanceService.getTeamEntry(effectiveUserId);
    if (!row) return null;

    const higherCount = await TradingPerformanceService.countTeamsAbove({
      id: row.id,
      createdAt: row.createdAt,
      teamTradingReturn: row.teamTradingReturn,
    });

    const rank = higherCount + 1;
    return {
      rank,
      page: Math.ceil(rank / pageSize),
      entry: mapTeamEntry(row, rank),
    };
  }
}
