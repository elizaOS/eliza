/**
 * NPC Interaction Tracker
 *
 * Tracks all user interactions with NPCs:
 * - Replies to NPC posts
 * - Likes on NPC posts
 * - Shares/retweets of NPC posts
 * - Trading activity (optional)
 *
 * Calculates engagement scores for group invite eligibility.
 * Uses configurable thresholds from ALPHA_GROUP_CONFIG.
 */

import {
  agentTrades,
  and,
  count,
  db,
  eq,
  gte,
  inArray,
  lte,
  posts,
  reactions,
  shares,
  userInteractions,
  users,
} from '@babylon/db';
import { logger } from '@babylon/shared';
import { ALPHA_GROUP_CONFIG } from '../config/alpha-group-config';

/**
 * Trading statistics for a user within a time window.
 */
export interface TradingStats {
  /** Total number of closed trades */
  totalTrades: number;
  /** Number of trades with positive P&L */
  profitableTrades: number;
  /** Cumulative P&L (can be negative) */
  totalPnL: number;
  /** Win rate (profitableTrades / totalTrades), 0-1 */
  winRate: number;
}

/**
 * Complete engagement score including social and trading metrics.
 */
export interface NPCInteractionScore {
  userId: string;
  npcId: string;
  // Social metrics
  replyCount: number;
  likeCount: number;
  shareCount: number;
  totalInteractions: number;
  avgQualityScore: number;
  // Trading metrics
  tradingStats: TradingStats;
  // Individual scores (before weighting)
  socialScore: number;
  tradingScore: number;
  // Combined weighted score
  engagementScore: number; // 0-100 score
  // Eligibility
  isEligibleForInvite: boolean;
  eligibilityReasons: string[];
  // Fast track status
  qualifiesForFastTrack: boolean;
}

/**
 * Time window for interaction queries.
 */
export interface InteractionWindow {
  startDate: Date;
  endDate: Date;
}

/**
 * Focus weights for engagement calculation.
 * Controls how social vs trading activity contributes to the score.
 */
export interface FocusWeights {
  social: number;
  trading: number;
}

export class NPCInteractionTracker {
  /**
   * Track a like interaction (for logging/validation only).
   * Actual like data is stored in the Reaction table.
   */
  static async trackLike(userId: string, postId: string): Promise<void> {
    const [post] = await db
      .select({ authorId: posts.authorId })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);

    if (!post) {
      return;
    }

    const [author] = await db
      .select({ isActor: users.isActor })
      .from(users)
      .where(eq(users.id, post.authorId))
      .limit(1);

    if (!author?.isActor) {
      return;
    }

    logger.debug(
      `User ${userId} liked NPC ${post.authorId}'s post`,
      undefined,
      'NPCInteractionTracker'
    );
  }

  /**
   * Track a share/retweet interaction (for logging/validation only).
   * Actual share data is stored in the Share table.
   */
  static async trackShare(userId: string, postId: string): Promise<void> {
    const [post] = await db
      .select({ authorId: posts.authorId })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);

    if (!post) {
      return;
    }

    const [author] = await db
      .select({ isActor: users.isActor })
      .from(users)
      .where(eq(users.id, post.authorId))
      .limit(1);

    if (!author?.isActor) {
      return;
    }

    logger.debug(
      `User ${userId} shared NPC ${post.authorId}'s post`,
      undefined,
      'NPCInteractionTracker'
    );
  }

  /**
   * Get user's trading statistics within a time window.
   * Queries the AgentTrade table for closed trade history.
   */
  static async getUserTradingStats(
    userId: string,
    window?: InteractionWindow
  ): Promise<TradingStats> {
    const endDate = window?.endDate || new Date();
    const startDate =
      window?.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Query closed trades from AgentTrade table
    const trades = await db
      .select({
        pnl: agentTrades.pnl,
        action: agentTrades.action,
      })
      .from(agentTrades)
      .where(
        and(
          eq(agentTrades.agentUserId, userId),
          eq(agentTrades.action, 'close'),
          gte(agentTrades.executedAt, startDate),
          lte(agentTrades.executedAt, endDate)
        )
      );

    const totalTrades = trades.length;
    const profitableTrades = trades.filter((t) => (t.pnl ?? 0) > 0).length;
    const totalPnL = trades.reduce((acc, t) => acc + (t.pnl ?? 0), 0);
    const winRate = totalTrades > 0 ? profitableTrades / totalTrades : 0;

    return {
      totalTrades,
      profitableTrades,
      totalPnL,
      winRate,
    };
  }

  /**
   * Calculate engagement score for a user with an NPC.
   *
   * The score combines social interactions and trading activity,
   * weighted by focus weights (can be NPC-specific or domain-based).
   *
   * @param userId - User ID to calculate score for
   * @param npcId - NPC ID to calculate engagement with
   * @param window - Optional time window (defaults to last 30 days)
   * @param focusWeights - Optional custom focus weights (defaults to domain-based)
   */
  static async calculateEngagementScore(
    userId: string,
    npcId: string,
    window?: InteractionWindow,
    focusWeights?: FocusWeights
  ): Promise<NPCInteractionScore> {
    const endDate = window?.endDate || new Date();
    const startDate =
      window?.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Ensure effective end date doesn't exceed current time
    const now = new Date();
    const effectiveEndDate = endDate > now ? now : endDate;

    // ==========================================================================
    // SOCIAL INTERACTIONS
    // ==========================================================================

    // Get all NPC posts in the time window
    const npcPosts = await db
      .select({ id: posts.id })
      .from(posts)
      .where(
        and(
          eq(posts.authorId, npcId),
          gte(posts.timestamp, startDate),
          lte(posts.timestamp, effectiveEndDate)
        )
      );

    const npcPostIds = npcPosts.map((p) => p.id);

    // Count replies (from UserInteraction table)
    const replyInteractions = await db
      .select({ qualityScore: userInteractions.qualityScore })
      .from(userInteractions)
      .where(
        and(
          eq(userInteractions.userId, userId),
          eq(userInteractions.npcId, npcId),
          gte(userInteractions.timestamp, startDate),
          lte(userInteractions.timestamp, endDate)
        )
      );

    const replyCount = replyInteractions.length;
    const avgQualityScore =
      replyCount > 0
        ? replyInteractions.reduce((acc, i) => acc + i.qualityScore, 0) /
          replyCount
        : 0;

    // Count likes
    let likeCount = 0;
    if (npcPostIds.length > 0) {
      const [likeResult] = await db
        .select({ count: count() })
        .from(reactions)
        .where(
          and(
            eq(reactions.userId, userId),
            inArray(reactions.postId, npcPostIds),
            eq(reactions.type, 'like'),
            gte(reactions.createdAt, startDate),
            lte(reactions.createdAt, endDate)
          )
        );
      likeCount = likeResult?.count ?? 0;
    }

    // Count shares
    let shareCount = 0;
    if (npcPostIds.length > 0) {
      const [shareResult] = await db
        .select({ count: count() })
        .from(shares)
        .where(
          and(
            eq(shares.userId, userId),
            inArray(shares.postId, npcPostIds),
            gte(shares.createdAt, startDate),
            lte(shares.createdAt, endDate)
          )
        );
      shareCount = shareResult?.count ?? 0;
    }

    const totalInteractions = replyCount + likeCount + shareCount;

    // ==========================================================================
    // TRADING ACTIVITY
    // ==========================================================================

    let tradingStats: TradingStats = {
      totalTrades: 0,
      profitableTrades: 0,
      totalPnL: 0,
      winRate: 0,
    };

    // Fetch trading stats if either:
    // 1. Trading activity is included in engagement score, OR
    // 2. Fast-track is enabled (fast-track requires trading stats even if not in score)
    if (
      ALPHA_GROUP_CONFIG.includeTradingActivity ||
      ALPHA_GROUP_CONFIG.fastTrackEnabled
    ) {
      tradingStats = await this.getUserTradingStats(userId, {
        startDate,
        endDate,
      });
    }

    // ==========================================================================
    // SCORE CALCULATION
    // ==========================================================================

    // Calculate raw social score
    const replyScore = replyCount * ALPHA_GROUP_CONFIG.replyWeight;
    const likeScore = likeCount * ALPHA_GROUP_CONFIG.likeWeight;
    const shareScore = shareCount * ALPHA_GROUP_CONFIG.shareWeight;
    const rawSocialScore = replyScore + likeScore + shareScore;

    // Normalize social score to 0-100
    const socialScore = Math.min(
      100,
      (rawSocialScore / ALPHA_GROUP_CONFIG.maxExpectedSocialScore) * 100
    );

    // Calculate raw trading score (only used in engagement if includeTradingActivity=true)
    // Note: tradingStats are still fetched if fastTrackEnabled for fast-track eligibility
    let tradingScore = 0;
    if (ALPHA_GROUP_CONFIG.includeTradingActivity) {
      const tradeScore =
        tradingStats.totalTrades * ALPHA_GROUP_CONFIG.tradeWeight;
      const profitBonus =
        tradingStats.profitableTrades * ALPHA_GROUP_CONFIG.profitableTradeBonus;
      const rawTradingScore = tradeScore + profitBonus;

      // Normalize trading score to 0-100
      tradingScore = Math.min(
        100,
        (rawTradingScore / ALPHA_GROUP_CONFIG.maxExpectedTradingScore) * 100
      );
    }

    // Apply focus weights (use provided or default)
    // When trading is disabled, trading weight effectively becomes 0
    const weights = focusWeights || {
      social: ALPHA_GROUP_CONFIG.defaultSocialWeight,
      trading: ALPHA_GROUP_CONFIG.includeTradingActivity
        ? ALPHA_GROUP_CONFIG.defaultTradingWeight
        : 0,
    };
    // Normalize weights to ensure they sum to 1 (when one is zero, use only the other)
    const totalWeight = weights.social + weights.trading;
    const normalizedWeights =
      totalWeight > 0
        ? {
            social: weights.social / totalWeight,
            trading: weights.trading / totalWeight,
          }
        : { social: 1, trading: 0 };
    const weightedScore =
      socialScore * normalizedWeights.social +
      tradingScore * normalizedWeights.trading;

    // Apply quality multiplier for high-quality replies
    const qualityMultiplier =
      avgQualityScore > ALPHA_GROUP_CONFIG.qualityThreshold
        ? ALPHA_GROUP_CONFIG.qualityMultiplier
        : 1.0;
    const finalScore = Math.min(100, weightedScore * qualityMultiplier);

    // ==========================================================================
    // ELIGIBILITY DETERMINATION
    // ==========================================================================

    const eligibilityReasons: string[] = [];
    let isEligible = true;

    // Check social thresholds
    if (replyCount < ALPHA_GROUP_CONFIG.minReplies) {
      isEligible = false;
      eligibilityReasons.push(
        `Need ${ALPHA_GROUP_CONFIG.minReplies - replyCount} more replies`
      );
    }

    if (likeCount < ALPHA_GROUP_CONFIG.minLikes) {
      isEligible = false;
      eligibilityReasons.push(
        `Need ${ALPHA_GROUP_CONFIG.minLikes - likeCount} more likes`
      );
    }

    if (totalInteractions < ALPHA_GROUP_CONFIG.minTotalInteractions) {
      isEligible = false;
      eligibilityReasons.push(
        `Need ${ALPHA_GROUP_CONFIG.minTotalInteractions - totalInteractions} more interactions`
      );
    }

    // Check quality threshold
    if (
      avgQualityScore < ALPHA_GROUP_CONFIG.minQualityScore &&
      replyCount > 0
    ) {
      isEligible = false;
      eligibilityReasons.push(
        `Reply quality too low (${(avgQualityScore * 100).toFixed(0)}% < ${(ALPHA_GROUP_CONFIG.minQualityScore * 100).toFixed(0)}%)`
      );
    }

    // Check for spam (too many interactions per day)
    const daysSinceStart =
      (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
    const interactionsPerDay =
      daysSinceStart > 0
        ? totalInteractions / daysSinceStart
        : totalInteractions;

    if (interactionsPerDay > ALPHA_GROUP_CONFIG.maxInteractionsPerDay) {
      isEligible = false;
      eligibilityReasons.push(
        `Too many interactions per day (${interactionsPerDay.toFixed(0)}/day exceeds ${ALPHA_GROUP_CONFIG.maxInteractionsPerDay}/day limit)`
      );
    }

    // ==========================================================================
    // FAST TRACK CHECK
    // ==========================================================================

    const qualifiesForFastTrack =
      ALPHA_GROUP_CONFIG.fastTrackEnabled &&
      tradingStats.totalTrades >= ALPHA_GROUP_CONFIG.fastTrackMinTrades &&
      tradingStats.totalPnL >= ALPHA_GROUP_CONFIG.fastTrackMinPnL &&
      tradingStats.winRate >= ALPHA_GROUP_CONFIG.fastTrackMinWinRate;

    // Fast-track overrides social requirements
    if (qualifiesForFastTrack && !isEligible) {
      isEligible = true;
      eligibilityReasons.length = 0; // Clear previous reasons
      eligibilityReasons.push(
        `Fast-tracked: ${tradingStats.totalTrades} trades, ` +
          `${(tradingStats.winRate * 100).toFixed(0)}% win rate, ` +
          `${tradingStats.totalPnL.toFixed(0)} P&L`
      );
    }

    // Add success message if eligible
    if (isEligible) {
      eligibilityReasons.push('Eligible for group invite');
      eligibilityReasons.push(
        `Score: ${finalScore.toFixed(0)}/100 (social: ${socialScore.toFixed(0)}, trading: ${tradingScore.toFixed(0)})`
      );
    }

    return {
      userId,
      npcId,
      replyCount,
      likeCount,
      shareCount,
      totalInteractions,
      avgQualityScore,
      tradingStats,
      socialScore,
      tradingScore,
      engagementScore: finalScore,
      isEligibleForInvite: isEligible,
      eligibilityReasons,
      qualifiesForFastTrack,
    };
  }

  /**
   * Get top users by engagement with an NPC.
   *
   * @param npcId - NPC ID to get top users for
   * @param limit - Maximum number of users to return
   * @param window - Optional time window
   * @param focusWeights - Optional custom focus weights
   */
  static async getTopEngagedUsers(
    npcId: string,
    limit = 10,
    window?: InteractionWindow,
    focusWeights?: FocusWeights
  ): Promise<NPCInteractionScore[]> {
    // Build conditions for finding users who interacted with this NPC
    const conditions = [eq(userInteractions.npcId, npcId)];
    if (window) {
      conditions.push(gte(userInteractions.timestamp, window.startDate));
      conditions.push(lte(userInteractions.timestamp, window.endDate));
    }

    // Get all users who have interacted with this NPC
    const interactions = await db
      .selectDistinct({ userId: userInteractions.userId })
      .from(userInteractions)
      .where(and(...conditions));

    const userIds = interactions.map((i) => i.userId);

    // Calculate scores for each user
    const scores = await Promise.all(
      userIds.map((userId) =>
        NPCInteractionTracker.calculateEngagementScore(
          userId,
          npcId,
          window,
          focusWeights
        )
      )
    );

    // Sort by engagement score (descending) and return top N
    return scores
      .sort((a, b) => b.engagementScore - a.engagementScore)
      .slice(0, limit);
  }

  /**
   * Get all NPCs a user has engaged with.
   *
   * @param userId - User ID to get engaged NPCs for
   * @param window - Optional time window
   */
  static async getUserEngagedNPCs(
    userId: string,
    window?: InteractionWindow
  ): Promise<string[]> {
    const conditions = [eq(userInteractions.userId, userId)];
    if (window) {
      conditions.push(gte(userInteractions.timestamp, window.startDate));
      conditions.push(lte(userInteractions.timestamp, window.endDate));
    }

    const interactions = await db
      .selectDistinct({ npcId: userInteractions.npcId })
      .from(userInteractions)
      .where(and(...conditions));

    return interactions.map((i) => i.npcId);
  }

  /**
   * Check if a user qualifies for fast-track to higher tiers.
   * Fast-track is based on trading performance only.
   *
   * @param userId - User ID to check
   * @param window - Optional time window
   */
  static async checkFastTrackEligibility(
    userId: string,
    window?: InteractionWindow
  ): Promise<{
    eligible: boolean;
    tradingStats: TradingStats;
    reason: string;
  }> {
    if (!ALPHA_GROUP_CONFIG.fastTrackEnabled) {
      return {
        eligible: false,
        tradingStats: {
          totalTrades: 0,
          profitableTrades: 0,
          totalPnL: 0,
          winRate: 0,
        },
        reason: 'Fast-track is disabled',
      };
    }

    const tradingStats = await this.getUserTradingStats(userId, window);

    if (tradingStats.totalTrades < ALPHA_GROUP_CONFIG.fastTrackMinTrades) {
      return {
        eligible: false,
        tradingStats,
        reason: `Need ${ALPHA_GROUP_CONFIG.fastTrackMinTrades - tradingStats.totalTrades} more trades`,
      };
    }

    if (tradingStats.totalPnL < ALPHA_GROUP_CONFIG.fastTrackMinPnL) {
      return {
        eligible: false,
        tradingStats,
        reason: `Need ${(ALPHA_GROUP_CONFIG.fastTrackMinPnL - tradingStats.totalPnL).toFixed(0)} more P&L`,
      };
    }

    if (tradingStats.winRate < ALPHA_GROUP_CONFIG.fastTrackMinWinRate) {
      return {
        eligible: false,
        tradingStats,
        reason: `Win rate ${(tradingStats.winRate * 100).toFixed(0)}% < ${(ALPHA_GROUP_CONFIG.fastTrackMinWinRate * 100).toFixed(0)}% required`,
      };
    }

    return {
      eligible: true,
      tradingStats,
      reason: 'Qualifies for fast-track',
    };
  }
}
