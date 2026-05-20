/**
 * Reputation Calculation Service
 *
 * Aggregates performance metrics and feedback to calculate composite reputation scores.
 * Integrates PNL normalization, game scores, and user feedback into reputation.
 */

import {
  agentPerformanceMetrics,
  and,
  db,
  desc,
  eq,
  feedbacks,
  gte,
  users,
} from '@babylon/db';
import { generateSnowflakeId, logger } from '@babylon/shared';
import { clamp01, clampPercent } from '../utils/math-utils';
import {
  calculateConfidenceScore,
  calculateWinRate,
  getTrustLevel,
  normalizePnL,
} from './pnl-normalizer';

export interface ReputationScoreBreakdown {
  reputationScore: number;
  trustLevel: string;
  confidenceScore: number;
  breakdown: {
    pnlComponent: number;
    feedbackComponent: number;
    activityComponent: number;
  };
  metrics: {
    normalizedPnL: number;
    averageFeedbackScore: number;
    gamesPlayed: number;
    totalFeedbackCount: number;
    winRate: number;
  };
}

/**
 * Updated reputation metrics after recalculation
 */
export interface RecalculatedReputation {
  userId: string;
  reputationScore: number;
  trustLevel: string;
  confidenceScore: number;
}

/**
 * Leaderboard entry for reputation rankings
 */
export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  isActor: boolean | null;
  reputationScore: number;
  trustLevel: string;
  confidenceScore: number;
  gamesPlayed: number;
  winRate: number | null;
  normalizedPnL: number;
}

/**
 * Game performance metrics for auto-feedback generation
 */
export interface GameMetrics {
  won: boolean;
  pnl: number;
  positionsClosed: number;
  finalBalance: number;
  startingBalance: number;
  decisionsCorrect: number;
  decisionsTotal: number;
  timeToComplete?: number;
  riskManagement?: number;
}

/**
 * Trade performance metrics for auto-feedback generation
 */
export interface TradeMetrics {
  profitable: boolean;
  roi: number;
  holdingPeriod: number;
  timingScore: number;
  riskScore: number;
}

/**
 * Calculate composite reputation score for a user/agent
 *
 * Weighted composite formula:
 * Reputation = (PNL * 0.4) + (Feedback * 0.4) + (Activity * 0.2)
 *
 * Components:
 * - PNL (40%): Normalized profit/loss performance (0-100)
 * - Feedback (40%): Average feedback score from others (0-100)
 * - Activity (20%): Games/interactions played (0-100, capped at 50 games)
 *
 * @param normalizedPnL - PNL normalized to 0-1 scale
 * @param averageFeedbackScore - Average feedback score (0-100)
 * @param gamesPlayed - Number of games played
 * @returns Composite reputation score (0-100)
 */
export function calculateReputationScore(
  normalizedPnL: number,
  averageFeedbackScore: number,
  gamesPlayed: number,
  winRate = 0,
  intelScore = averageFeedbackScore
): number {
  // Weight distribution
  const pnlWeight = 0.4;
  const feedbackWeight = 0.4;
  const activityWeight = 0.2;

  // Performance component mixes normalized PnL (70%) and win rate (30%)
  const performanceScore = normalizedPnL * 0.7 + winRate * 0.3;
  const pnlComponent = performanceScore * 100;

  // Feedback blend: general feedback (70%) + intel-specific feedback (30%)
  const feedbackComponent = averageFeedbackScore * 0.7 + intelScore * 0.3;

  // Activity bonus: linear scaling, caps at 50 games = 100 points
  // 0 games = 0 points, 25 games = 50 points, 50+ games = 100 points
  const activityComponent = Math.min(100, gamesPlayed * 2);

  // Weighted sum
  const score =
    pnlComponent * pnlWeight +
    feedbackComponent * feedbackWeight +
    activityComponent * activityWeight;

  // Clamp to [0, 100]
  return clampPercent(score);
}

/**
 * Update agent performance metrics based on completed game
 *
 * @param userId - User/agent ID
 * @param gameScore - Game performance score (0-100)
 * @param won - Whether the game was won
 * @returns Updated metrics
 */
export async function updateGameMetrics(
  userId: string,
  gameScore: number,
  won: boolean
) {
  logger.info(
    'Updating game metrics',
    { userId, gameScore, won },
    'ReputationService'
  );

  // Get or create metrics
  let [metrics] = await db
    .select()
    .from(agentPerformanceMetrics)
    .where(eq(agentPerformanceMetrics.userId, userId))
    .limit(1);

  if (!metrics) {
    await db.insert(agentPerformanceMetrics).values({
      id: await generateSnowflakeId(),
      userId,
      gamesPlayed: 0,
      gamesWon: 0,
      averageGameScore: 0,
      updatedAt: new Date(),
    });

    [metrics] = await db
      .select()
      .from(agentPerformanceMetrics)
      .where(eq(agentPerformanceMetrics.userId, userId))
      .limit(1);
  }

  if (!metrics) {
    throw new Error(`Failed to create metrics for user ${userId}`);
  }

  // Calculate new average game score
  const totalGames = metrics.gamesPlayed + 1;
  const newAverageScore =
    (metrics.averageGameScore * metrics.gamesPlayed + gameScore) / totalGames;

  // Update metrics
  await db
    .update(agentPerformanceMetrics)
    .set({
      gamesPlayed: totalGames,
      gamesWon: won ? metrics.gamesWon + 1 : metrics.gamesWon,
      averageGameScore: newAverageScore,
      lastGameScore: gameScore,
      lastGamePlayedAt: new Date(),
      lastActivityAt: new Date(),
      firstActivityAt: metrics.firstActivityAt || new Date(),
    })
    .where(eq(agentPerformanceMetrics.userId, userId));

  // Recalculate reputation
  await recalculateReputation(userId);

  // Return updated metrics
  const [updated] = await db
    .select()
    .from(agentPerformanceMetrics)
    .where(eq(agentPerformanceMetrics.userId, userId))
    .limit(1);

  return updated;
}

/**
 * Update trading performance metrics
 *
 * @param userId - User/agent ID
 * @param pnl - Profit/loss from trade
 * @param invested - Amount invested
 * @param profitable - Whether trade was profitable
 */
export async function updateTradingMetrics(
  userId: string,
  pnl: number,
  invested: number,
  profitable: boolean
) {
  logger.info(
    'Updating trading metrics',
    { userId, pnl, invested, profitable },
    'ReputationService'
  );

  // Get user's lifetime PNL and total deposits
  const [user] = await db
    .select({
      lifetimePnL: users.lifetimePnL,
      totalDeposited: users.totalDeposited,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    throw new Error(`User ${userId} not found`);
  }

  // Normalize PNL based on total deposits
  const totalInvested = Number.parseFloat(user.totalDeposited.toString());
  const lifetimePnLNum = Number.parseFloat(user.lifetimePnL.toString());
  const normalized = normalizePnL(lifetimePnLNum, totalInvested);

  // Get or create metrics
  let [metrics] = await db
    .select()
    .from(agentPerformanceMetrics)
    .where(eq(agentPerformanceMetrics.userId, userId))
    .limit(1);

  if (!metrics) {
    await db.insert(agentPerformanceMetrics).values({
      id: await generateSnowflakeId(),
      userId,
      normalizedPnL: normalized,
      totalTrades: 0,
      profitableTrades: 0,
      updatedAt: new Date(),
    });

    [metrics] = await db
      .select()
      .from(agentPerformanceMetrics)
      .where(eq(agentPerformanceMetrics.userId, userId))
      .limit(1);
  }

  if (!metrics) {
    throw new Error(`Failed to create metrics for user ${userId}`);
  }

  // Update trade counts
  const newTotalTrades = metrics.totalTrades + 1;
  const newProfitableTrades = profitable
    ? metrics.profitableTrades + 1
    : metrics.profitableTrades;

  // Calculate win rate
  const winRate = calculateWinRate(newProfitableTrades, newTotalTrades);

  // Calculate average ROI (simplified - would need full trade history for accuracy)
  const avgROI = lifetimePnLNum / totalInvested;

  // Update metrics
  await db
    .update(agentPerformanceMetrics)
    .set({
      normalizedPnL: normalized,
      totalTrades: newTotalTrades,
      profitableTrades: newProfitableTrades,
      winRate,
      averageROI: avgROI,
      lastActivityAt: new Date(),
      firstActivityAt: metrics.firstActivityAt || new Date(),
    })
    .where(eq(agentPerformanceMetrics.userId, userId));

  // Recalculate reputation
  await recalculateReputation(userId);

  // Return updated metrics
  const [updated] = await db
    .select()
    .from(agentPerformanceMetrics)
    .where(eq(agentPerformanceMetrics.userId, userId))
    .limit(1);

  return updated;
}

/**
 * Update feedback metrics when new feedback is submitted
 *
 * @param userId - User/agent receiving feedback
 * @param score - Feedback score (0-100)
 */
interface FeedbackContext {
  category?: string | null;
  interactionType?: string | null;
}

export async function updateFeedbackMetrics(
  userId: string,
  score: number,
  context?: FeedbackContext
) {
  logger.info(
    'Updating feedback metrics',
    {
      userId,
      score,
      category: context?.category,
      interactionType: context?.interactionType,
    },
    'ReputationService'
  );

  // Get or create metrics
  let [metrics] = await db
    .select()
    .from(agentPerformanceMetrics)
    .where(eq(agentPerformanceMetrics.userId, userId))
    .limit(1);

  if (!metrics) {
    await db.insert(agentPerformanceMetrics).values({
      id: await generateSnowflakeId(),
      userId,
      totalFeedbackCount: 0,
      averageFeedbackScore: 50, // Start at neutral
      intelFeedbackCount: 0,
      averageIntelScore: 50,
      updatedAt: new Date(),
    });

    [metrics] = await db
      .select()
      .from(agentPerformanceMetrics)
      .where(eq(agentPerformanceMetrics.userId, userId))
      .limit(1);
  }

  if (!metrics) {
    throw new Error(`Failed to create metrics for user ${userId}`);
  }

  // Calculate new average
  const newCount = metrics.totalFeedbackCount + 1;
  const newAverage =
    (metrics.averageFeedbackScore * metrics.totalFeedbackCount + score) /
    newCount;

  // Classify feedback
  const isPositive = score >= 70;
  const isNeutral = score >= 40 && score < 70;
  const isNegative = score < 40;

  const category = context?.category?.toLowerCase();
  const interactionType = context?.interactionType?.toLowerCase();
  const isIntel =
    category === 'intel' ||
    category === 'helpful_intel' ||
    interactionType === 'intel';

  let intelFeedbackCount = metrics.intelFeedbackCount ?? 0;
  let averageIntelScore = metrics.averageIntelScore ?? 50;

  if (isIntel) {
    const newIntelCount = intelFeedbackCount + 1;
    const newIntelAverage =
      (averageIntelScore * intelFeedbackCount + score) / newIntelCount;
    intelFeedbackCount = newIntelCount;
    averageIntelScore = newIntelAverage;
  }

  // Update metrics
  await db
    .update(agentPerformanceMetrics)
    .set({
      totalFeedbackCount: newCount,
      averageFeedbackScore: newAverage,
      intelFeedbackCount,
      averageIntelScore,
      positiveCount: isPositive
        ? metrics.positiveCount + 1
        : metrics.positiveCount,
      neutralCount: isNeutral ? metrics.neutralCount + 1 : metrics.neutralCount,
      negativeCount: isNegative
        ? metrics.negativeCount + 1
        : metrics.negativeCount,
      totalInteractions: metrics.totalInteractions + 1,
      lastActivityAt: new Date(),
      firstActivityAt: metrics.firstActivityAt || new Date(),
    })
    .where(eq(agentPerformanceMetrics.userId, userId));

  // Recalculate reputation
  await recalculateReputation(userId);

  // Return updated metrics
  const [updated] = await db
    .select()
    .from(agentPerformanceMetrics)
    .where(eq(agentPerformanceMetrics.userId, userId))
    .limit(1);

  return updated;
}

/**
 * Recalculate composite reputation score for a user
 *
 * @param userId - User/agent ID
 * @returns Updated metrics with new reputation score
 */
export async function recalculateReputation(
  userId: string
): Promise<RecalculatedReputation | null> {
  const [metrics] = await db
    .select()
    .from(agentPerformanceMetrics)
    .where(eq(agentPerformanceMetrics.userId, userId))
    .limit(1);

  if (!metrics) {
    return null;
  }

  // Calculate composite reputation
  const reputationScore = calculateReputationScore(
    metrics.normalizedPnL,
    metrics.averageFeedbackScore,
    metrics.gamesPlayed,
    metrics.winRate ?? 0,
    metrics.averageIntelScore ?? metrics.averageFeedbackScore
  );

  // Determine trust level
  const trustLevel = getTrustLevel(reputationScore);

  // Calculate confidence based on sample size (games + feedback)
  const sampleSize = metrics.gamesPlayed + metrics.totalFeedbackCount;
  const confidenceScore = calculateConfidenceScore(sampleSize);

  // Update metrics
  await db
    .update(agentPerformanceMetrics)
    .set({
      reputationScore,
      trustLevel,
      confidenceScore,
    })
    .where(eq(agentPerformanceMetrics.userId, userId));

  logger.info(
    'Recalculated reputation',
    { userId, reputationScore, trustLevel, confidenceScore },
    'ReputationService'
  );

  return {
    userId,
    reputationScore,
    trustLevel,
    confidenceScore,
  };
}

/**
 * Get detailed reputation breakdown for a user
 *
 * @param userId - User/agent ID
 * @returns Reputation score with component breakdown
 */
export async function getReputationBreakdown(
  userId: string
): Promise<ReputationScoreBreakdown | null> {
  let [metrics] = await db
    .select()
    .from(agentPerformanceMetrics)
    .where(eq(agentPerformanceMetrics.userId, userId))
    .limit(1);

  if (!metrics) {
    await db.insert(agentPerformanceMetrics).values({
      id: await generateSnowflakeId(),
      userId,
      updatedAt: new Date(),
    });

    [metrics] = await db
      .select()
      .from(agentPerformanceMetrics)
      .where(eq(agentPerformanceMetrics.userId, userId))
      .limit(1);
  }

  if (!metrics) {
    return null;
  }

  // Calculate components
  const pnlComponent = metrics.normalizedPnL * 100;
  const feedbackComponent = metrics.averageFeedbackScore;
  const activityComponent = Math.min(100, metrics.gamesPlayed * 2);

  return {
    reputationScore: metrics.reputationScore,
    trustLevel: metrics.trustLevel,
    confidenceScore: metrics.confidenceScore,
    breakdown: {
      pnlComponent,
      feedbackComponent,
      activityComponent,
    },
    metrics: {
      normalizedPnL: metrics.normalizedPnL,
      averageFeedbackScore: metrics.averageFeedbackScore,
      gamesPlayed: metrics.gamesPlayed,
      totalFeedbackCount: metrics.totalFeedbackCount,
      winRate: metrics.winRate,
    },
  };
}

/**
 * Get leaderboard of top-rated agents
 *
 * @param limit - Number of agents to return
 * @param minGames - Minimum games played to qualify
 * @returns Array of agents sorted by reputation score
 */
export async function getReputationLeaderboard(
  limit = 100,
  minGames = 5,
  options?: {
    activeSince?: Date | null;
  }
): Promise<LeaderboardEntry[]> {
  const leaderboardFilters = [
    gte(agentPerformanceMetrics.gamesPlayed, minGames),
  ];

  if (options?.activeSince) {
    leaderboardFilters.push(
      gte(agentPerformanceMetrics.lastActivityAt, options.activeSince)
    );
  }

  const topAgents = await db
    .select({
      userId: agentPerformanceMetrics.userId,
      reputationScore: agentPerformanceMetrics.reputationScore,
      trustLevel: agentPerformanceMetrics.trustLevel,
      confidenceScore: agentPerformanceMetrics.confidenceScore,
      gamesPlayed: agentPerformanceMetrics.gamesPlayed,
      winRate: agentPerformanceMetrics.winRate,
      normalizedPnL: agentPerformanceMetrics.normalizedPnL,
    })
    .from(agentPerformanceMetrics)
    .where(and(...leaderboardFilters))
    .orderBy(desc(agentPerformanceMetrics.reputationScore))
    .limit(limit);

  // Fetch user data for each agent
  const results = await Promise.all(
    topAgents.map(async (agent, index) => {
      const [user] = await db
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          profileImageUrl: users.profileImageUrl,
          isActor: users.isActor,
        })
        .from(users)
        .where(eq(users.id, agent.userId))
        .limit(1);

      return {
        rank: index + 1,
        userId: agent.userId,
        username: user?.username ?? null,
        displayName: user?.displayName ?? null,
        profileImageUrl: user?.profileImageUrl ?? null,
        isActor: user?.isActor ?? null,
        reputationScore: agent.reputationScore,
        trustLevel: agent.trustLevel,
        confidenceScore: agent.confidenceScore,
        gamesPlayed: agent.gamesPlayed,
        winRate: agent.winRate,
        normalizedPnL: agent.normalizedPnL,
      };
    })
  );

  return results;
}

// AUTO-FEEDBACK GENERATION FUNCTIONS

/**
 * Calculate feedback score from game performance metrics
 *
 * Score components (0-100):
 * - PNL performance: 40% (normalized return on starting balance)
 * - Decision quality: 30% (correct decisions / total decisions)
 * - Risk management: 20% (positions managed effectively)
 * - Game outcome: 10% (win/loss bonus)
 *
 * @param metrics - Game performance metrics
 * @returns Feedback score (0-100)
 */
export function calculateGameScore(metrics: GameMetrics): number {
  // PNL component (40%)
  const normalizedRoi = normalizePnL(metrics.pnl, metrics.startingBalance);
  const pnlScore = normalizedRoi * 100 * 0.4;

  // Decision quality component (30%)
  const decisionAccuracy =
    metrics.decisionsTotal > 0
      ? metrics.decisionsCorrect / metrics.decisionsTotal
      : 0.5;
  const decisionScore = decisionAccuracy * 100 * 0.3;

  // Risk management component (20%)
  const riskScore = (metrics.riskManagement ?? 0.5) * 100 * 0.2;

  // Game outcome bonus (10%)
  const outcomeBonus = metrics.won ? 10 : 0;

  // Composite score
  const totalScore = pnlScore + decisionScore + riskScore + outcomeBonus;

  // Clamp to [0, 100]
  return clampPercent(totalScore);
}

/**
 * Calculate feedback score from trade performance metrics
 *
 * Score components (0-100):
 * - ROI: 50% (return on investment)
 * - Timing: 25% (entry/exit timing quality)
 * - Risk management: 25% (position sizing, stop losses)
 *
 * @param metrics - Trade performance metrics
 * @returns Feedback score (0-100)
 */
export function calculateTradeScore(metrics: TradeMetrics): number {
  // ROI component (50%) - normalize ROI to 0-1 scale
  // Assume -50% to +100% ROI range maps to 0-100 score
  const normalizedRoi = clamp01((metrics.roi + 0.5) / 1.5);
  const roiScore = normalizedRoi * 100 * 0.5;

  // Timing component (25%)
  const timingScore = metrics.timingScore * 100 * 0.25;

  // Risk management component (25%)
  const riskScore = metrics.riskScore * 100 * 0.25;

  // Composite score
  const totalScore = roiScore + timingScore + riskScore;

  // Clamp to [0, 100]
  return clampPercent(totalScore);
}

/**
 * Generate automatic feedback when agent completes a game
 *
 * Creates feedback record and updates agent metrics atomically.
 *
 * @param agentId - Agent user ID
 * @param gameId - Game identifier
 * @param performanceMetrics - Game performance data
 * @returns Created feedback record
 */
export async function generateGameCompletionFeedback(
  agentId: string,
  gameId: string,
  performanceMetrics: GameMetrics
) {
  logger.info(
    'Generating game completion feedback',
    { agentId, gameId },
    'AutoFeedback'
  );

  // Calculate feedback score from performance
  const score = calculateGameScore(performanceMetrics);

  // Determine comment based on performance
  let comment = '';
  if (score >= 80) {
    comment =
      'Excellent game performance! Strong decision-making and risk management.';
  } else if (score >= 60) {
    comment = 'Good game performance with solid fundamentals.';
  } else if (score >= 40) {
    comment = 'Moderate performance. Room for improvement in decision-making.';
  } else {
    comment =
      'Challenging game. Focus on improving risk management and decision quality.';
  }

  // Create feedback record
  const feedbackId = await generateSnowflakeId();
  await db.insert(feedbacks).values({
    id: feedbackId,
    toUserId: agentId,
    score,
    comment,
    category: 'game_performance',
    interactionType: 'game_to_agent',
    metadata: {
      gameId,
      won: performanceMetrics.won,
      pnl: performanceMetrics.pnl,
      decisionsCorrect: performanceMetrics.decisionsCorrect,
      decisionsTotal: performanceMetrics.decisionsTotal,
      autoGenerated: true,
      timestamp: new Date().toISOString(),
    },
    updatedAt: new Date(),
  });

  // Update game metrics (this will trigger reputation recalculation)
  await updateGameMetrics(agentId, score, performanceMetrics.won);

  await updateFeedbackMetrics(agentId, score, {
    category: 'game_performance',
    interactionType: 'game_to_agent',
  });

  // Get created feedback
  const [feedback] = await db
    .select()
    .from(feedbacks)
    .where(eq(feedbacks.id, feedbackId))
    .limit(1);

  logger.info('Generated game feedback', { feedbackId, score }, 'AutoFeedback');

  return feedback;
}

/**
 * Generate automatic feedback for trade execution
 *
 * @param agentId - Agent user ID
 * @param tradeId - Trade identifier
 * @param performanceMetrics - Trade performance data
 * @returns Created feedback record
 */
export async function generateTradeCompletionFeedback(
  agentId: string,
  tradeId: string,
  performanceMetrics: TradeMetrics
) {
  logger.info(
    'Generating trade completion feedback',
    { agentId, tradeId },
    'AutoFeedback'
  );

  // Calculate feedback score from trade performance
  const score = calculateTradeScore(performanceMetrics);

  // Determine comment
  let comment = '';
  if (score >= 80) {
    comment =
      'Excellent trade execution with strong timing and risk management.';
  } else if (score >= 60) {
    comment = 'Good trade performance with solid fundamentals.';
  } else if (score >= 40) {
    comment =
      'Moderate trade performance. Consider improving entry/exit timing.';
  } else {
    comment = 'Challenging trade. Focus on risk management and timing.';
  }

  // Create feedback record
  const feedbackId = await generateSnowflakeId();
  await db.insert(feedbacks).values({
    id: feedbackId,
    toUserId: agentId,
    score,
    comment,
    category: 'trade_performance',
    interactionType: 'game_to_agent',
    metadata: {
      tradeId,
      profitable: performanceMetrics.profitable,
      roi: performanceMetrics.roi,
      holdingPeriod: performanceMetrics.holdingPeriod,
      autoGenerated: true,
      timestamp: new Date().toISOString(),
    },
    updatedAt: new Date(),
  });

  // Update feedback metrics
  await updateFeedbackMetrics(agentId, score, {
    category: 'trade_performance',
    interactionType: 'trade_to_agent',
  });

  // Get created feedback
  const [feedback] = await db
    .select()
    .from(feedbacks)
    .where(eq(feedbacks.id, feedbackId))
    .limit(1);

  logger.info(
    'Generated trade feedback',
    { feedbackId, score },
    'AutoFeedback'
  );

  return feedback;
}

/**
 * Generate batch feedback for multiple completed games
 *
 * Useful for processing game completions in bulk or during sync operations.
 *
 * @param completions - Array of game completion data
 * @returns Array of created feedback records
 */
export async function generateBatchGameFeedback(
  completions: Array<{
    agentId: string;
    gameId: string;
    metrics: GameMetrics;
  }>
) {
  logger.info(
    'Generating batch game feedback',
    { count: completions.length },
    'AutoFeedback'
  );

  // Process sequentially to avoid overwhelming the database
  const results: PromiseSettledResult<
    Awaited<ReturnType<typeof generateGameCompletionFeedback>>
  >[] = [];

  for (const completion of completions) {
    const result = await generateGameCompletionFeedback(
      completion.agentId,
      completion.gameId,
      completion.metrics
    );
    results.push({ status: 'fulfilled', value: result });
  }

  const successful = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;

  logger.info(
    'Batch feedback generation complete',
    { successful, failed },
    'AutoFeedback'
  );

  return results
    .filter(
      (
        r
      ): r is PromiseFulfilledResult<
        Awaited<ReturnType<typeof generateGameCompletionFeedback>>
      > => r.status === 'fulfilled'
    )
    .map((r) => r.value);
}
