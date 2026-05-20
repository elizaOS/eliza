/**
 * Market Reputation Service
 *
 * Tracks prediction market outcomes in the local database.
 * Winners get +10 reputation points, losers get -5.
 *
 * On-chain reputation tracking via Base Sepolia contracts has been removed.
 * Reputation is now purely database-driven, with optional Agent0 feedback
 * propagation handled by the ReputationBridge in @feed/agents.
 */

import { db, eq, inArray, positions, sql, users } from "@feed/db";
import { logger } from "@feed/shared";

interface MarketResolution {
  marketId: string;
  outcome: boolean;
}

interface ReputationUpdate {
  userId: string;
  tokenId: number;
  change: number;
  txHash?: string;
  error?: string;
}

export class MarketReputationService {
  static async updateReputationForResolvedMarket(
    resolution: MarketResolution,
  ): Promise<ReputationUpdate[]> {
    const results: ReputationUpdate[] = [];

    const positionsData = await db
      .select({
        id: positions.id,
        userId: positions.userId,
        side: positions.side,
        shares: positions.shares,
      })
      .from(positions)
      .where(eq(positions.marketId, resolution.marketId));

    if (positionsData.length === 0) {
      logger.info(
        `No positions found for market ${resolution.marketId}`,
        undefined,
        "MarketReputationService",
      );
      return [];
    }

    const userIds = [...new Set(positionsData.map((p) => p.userId))];
    const usersData = await db
      .select({
        id: users.id,
        nftTokenId: users.nftTokenId,
        reputationPoints: users.reputationPoints,
      })
      .from(users)
      .where(inArray(users.id, userIds));

    const userMap = new Map(usersData.map((u) => [u.id, u]));

    logger.info(
      `Updating reputation for ${positionsData.length} positions in market ${resolution.marketId}`,
      { count: positionsData.length, marketId: resolution.marketId },
      "MarketReputationService",
    );

    for (const position of positionsData) {
      const user = userMap.get(position.userId);
      if (!user) {
        results.push({
          userId: position.userId,
          tokenId: 0,
          change: 0,
          error: "User not found",
        });
        continue;
      }

      const tokenId = user.nftTokenId ?? 0;
      const isWinner = position.side === resolution.outcome;
      const change = isWinner ? 10 : -5;

      const [updated] = await db
        .update(users)
        .set({
          reputationPoints: sql`GREATEST(0, COALESCE(${users.reputationPoints}, 0) + ${change})`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, position.userId))
        .returning({ reputationPoints: users.reputationPoints });

      results.push({
        userId: position.userId,
        tokenId,
        change,
      });

      logger.info(
        `Updated reputation for user ${position.userId}`,
        { tokenId, change, newReputation: updated?.reputationPoints },
        "MarketReputationService",
      );
    }

    return results;
  }

  static async getOnChainReputation(userId: string): Promise<number | null> {
    const [user] = await db
      .select({
        reputationPoints: users.reputationPoints,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) return null;

    return user.reputationPoints ?? null;
  }

  static async syncUserReputation(userId: string): Promise<number | null> {
    return MarketReputationService.getOnChainReputation(userId);
  }

  static async batchUpdateReputation(
    resolutions: MarketResolution[],
  ): Promise<Record<string, ReputationUpdate[]>> {
    const allResults: Record<string, ReputationUpdate[]> = {};

    for (const resolution of resolutions) {
      const results =
        await MarketReputationService.updateReputationForResolvedMarket(
          resolution,
        );
      allResults[resolution.marketId] = results;
    }

    return allResults;
  }
}
