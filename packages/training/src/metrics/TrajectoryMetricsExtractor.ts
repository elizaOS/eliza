/**
 * TrajectoryMetricsExtractor
 *
 * Extracts comprehensive behavioral metrics from agent trajectories
 * for use in multi-criteria LLM-as-judge evaluation.
 *
 * Extracts 5 categories of metrics:
 * - Social: group chats, DMs, posts, mentions
 * - Trading: P&L, win rate, Sharpe ratio, drawdown
 * - Influence: followers, reputation, reactions
 * - Behavior: action patterns, consistency
 * - Information: research, predictions
 *
 * @packageDocumentation
 */

import type { TrajectoryStep } from "../training/types";
import { logger } from "../utils/logger";
import type {
  BehavioralMetrics,
  BehaviorMetrics,
  InfluenceMetrics,
  InformationMetrics,
  SocialMetrics,
  TradingMetrics,
} from "./types";

/**
 * Action types that count as social interactions
 */
const SOCIAL_ACTION_TYPES = new Set([
  "join_group_chat",
  "create_group_chat",
  "leave_group_chat",
  "post_group_message",
  "send_dm",
  "reply_dm",
  "create_post",
  "comment",
  "like",
  "follow",
  "unfollow",
  "mention",
  "invite",
  "react",
  "share",
]);

/**
 * Action types that count as trading actions
 */
const TRADING_ACTION_TYPES = new Set([
  "trade",
  "buy",
  "sell",
  "place_order",
  "cancel_order",
  "close_position",
  "open_position",
  "predict",
  "bet",
  "swap",
]);

export class TrajectoryMetricsExtractor {
  /**
   * Extract all metrics from a trajectory
   */
  extract(params: {
    trajectoryId: string;
    agentId: string;
    steps: TrajectoryStep[];
    scenarioId?: string;
    startBalance?: number;
    endBalance?: number;
  }): BehavioralMetrics {
    const {
      trajectoryId,
      agentId,
      steps,
      scenarioId,
      startBalance,
      endBalance,
    } = params;

    const social = this.extractSocialMetrics(steps, agentId);
    const trading = this.extractTradingMetrics(steps, startBalance, endBalance);
    const influence = this.extractInfluenceMetrics(steps);
    const behavior = this.extractBehaviorMetrics(steps);
    const information = this.extractInformationMetrics(steps);

    return {
      social,
      trading,
      influence,
      behavior,
      information,
      extractedAt: new Date(),
      trajectoryId,
      agentId,
      scenarioId,
    };
  }

  /**
   * Extract social interaction metrics
   */
  private extractSocialMetrics(
    steps: TrajectoryStep[],
    agentId: string,
  ): SocialMetrics {
    const metrics: SocialMetrics = {
      groupChatsJoined: 0,
      groupChatsCreated: 0,
      groupMessagesSent: 0,
      dmsInitiated: 0,
      dmsReceived: 0,
      dmResponseRate: 0,
      uniqueUsersInteracted: 0,
      postsCreated: 0,
      commentsMade: 0,
      mentionsGiven: 0,
      mentionsReceived: 0,
      invitationsSent: 0,
    };

    const usersInteracted = new Set<string>();
    let dmsReplied = 0;

    for (const step of steps) {
      const action = step.action;
      if (!action) continue;

      const actionType = action.actionType.toLowerCase();
      const params = action.parameters || {};

      // Group chat actions
      if (actionType === "join_group_chat") {
        metrics.groupChatsJoined++;
      } else if (actionType === "create_group_chat") {
        metrics.groupChatsCreated++;
      } else if (
        actionType === "post_group_message" ||
        actionType === "group_message"
      ) {
        metrics.groupMessagesSent++;
        if (params.groupId) {
          usersInteracted.add(String(params.groupId));
        }
      }

      // DM actions
      else if (actionType === "send_dm" || actionType === "dm") {
        const isInitiator =
          params.initiator === agentId || params.fromAgent === agentId;
        if (isInitiator) {
          metrics.dmsInitiated++;
        }
        if (params.toUserId || params.recipientId) {
          usersInteracted.add(String(params.toUserId || params.recipientId));
        }
      } else if (actionType === "reply_dm") {
        dmsReplied++;
      }

      // Post/comment actions
      else if (actionType === "create_post" || actionType === "post") {
        metrics.postsCreated++;
      } else if (actionType === "comment" || actionType === "reply") {
        metrics.commentsMade++;
        if (params.authorId) {
          usersInteracted.add(String(params.authorId));
        }
      }

      // Mention/invite actions
      else if (actionType === "mention") {
        metrics.mentionsGiven++;
        if (params.mentionedUserId) {
          usersInteracted.add(String(params.mentionedUserId));
        }
      } else if (actionType === "invite") {
        metrics.invitationsSent++;
        if (params.invitedUserId) {
          usersInteracted.add(String(params.invitedUserId));
        }
      }

      // Track users from any interaction
      if (params.userId && params.userId !== agentId) {
        usersInteracted.add(String(params.userId));
      }
      if (params.targetUserId && params.targetUserId !== agentId) {
        usersInteracted.add(String(params.targetUserId));
      }
    }

    // Calculate DM response rate
    if (metrics.dmsReceived > 0) {
      metrics.dmResponseRate = dmsReplied / metrics.dmsReceived;
    }

    metrics.uniqueUsersInteracted = usersInteracted.size;

    return metrics;
  }

  /**
   * Extract trading performance metrics
   */
  private extractTradingMetrics(
    steps: TrajectoryStep[],
    startBalance?: number,
    endBalance?: number,
  ): TradingMetrics {
    const metrics: TradingMetrics = {
      tradesExecuted: 0,
      profitableTrades: 0,
      winRate: 0,
      totalPnL: 0,
      maxDrawdown: 0,
      sharpeRatio: 0,
      avgPositionSize: 0,
      avgHoldingPeriod: 0,
      marketsTraded: 0,
      buyTrades: 0,
      sellTrades: 0,
      largestWin: 0,
      largestLoss: 0,
    };

    const tradePnLs: number[] = [];
    const positionSizes: number[] = [];
    const marketsSet = new Set<string>();
    let runningPnL = 0;
    let peakPnL = 0;
    let maxDrawdown = 0;

    for (const step of steps) {
      const action = step.action;
      if (!action) continue;

      const actionType = action.actionType.toLowerCase();
      const params = action.parameters || {};
      const result = action.result || {};

      if (TRADING_ACTION_TYPES.has(actionType)) {
        metrics.tradesExecuted++;

        // Track buy/sell
        if (
          actionType === "buy" ||
          params.side === "buy" ||
          params.direction === "long"
        ) {
          metrics.buyTrades++;
        } else if (
          actionType === "sell" ||
          params.side === "sell" ||
          params.direction === "short"
        ) {
          metrics.sellTrades++;
        }

        // Track market
        const marketId = params.marketId || params.market || params.ticker;
        if (marketId) {
          marketsSet.add(String(marketId));
        }

        // Track position size
        const size = Number(
          params.amount || params.size || params.quantity || 0,
        );
        if (size > 0) {
          positionSizes.push(size);
        }

        // Track P&L from result
        const tradePnL = Number(
          result.pnl || result.profit || result.return || 0,
        );
        if (tradePnL !== 0) {
          tradePnLs.push(tradePnL);
          runningPnL += tradePnL;

          if (tradePnL > 0) {
            metrics.profitableTrades++;
            if (tradePnL > metrics.largestWin) {
              metrics.largestWin = tradePnL;
            }
          } else {
            if (tradePnL < metrics.largestLoss) {
              metrics.largestLoss = tradePnL;
            }
          }

          // Track drawdown
          if (runningPnL > peakPnL) {
            peakPnL = runningPnL;
          }
          const drawdown = peakPnL - runningPnL;
          if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
          }
        }
      }
    }

    // Calculate derived metrics
    if (metrics.tradesExecuted > 0) {
      metrics.winRate = metrics.profitableTrades / metrics.tradesExecuted;
    }

    // Calculate total P&L from trades or balance difference
    if (tradePnLs.length > 0) {
      metrics.totalPnL = tradePnLs.reduce((sum, pnl) => sum + pnl, 0);
    } else if (startBalance !== undefined && endBalance !== undefined) {
      metrics.totalPnL = endBalance - startBalance;
    }

    metrics.maxDrawdown = maxDrawdown;
    metrics.marketsTraded = marketsSet.size;

    // Average position size
    if (positionSizes.length > 0) {
      metrics.avgPositionSize =
        positionSizes.reduce((sum, s) => sum + s, 0) / positionSizes.length;
    }

    // Calculate Sharpe ratio (simplified)
    if (tradePnLs.length > 1) {
      const mean =
        tradePnLs.reduce((sum, pnl) => sum + pnl, 0) / tradePnLs.length;
      const variance =
        tradePnLs.reduce((sum, pnl) => sum + (pnl - mean) ** 2, 0) /
        tradePnLs.length;
      const stdDev = Math.sqrt(variance);
      if (stdDev > 0) {
        metrics.sharpeRatio = mean / stdDev;
      }
    }

    return metrics;
  }

  /**
   * Extract influence and reputation metrics
   */
  private extractInfluenceMetrics(steps: TrajectoryStep[]): InfluenceMetrics {
    const metrics: InfluenceMetrics = {
      followersGained: 0,
      reputationDelta: 0,
      trustLevelDelta: 0,
      influenceScore: 0,
      informationSpread: 0,
      positiveReactions: 0,
      negativeReactions: 0,
    };

    let startReputation: number | null = null;
    let endReputation: number | null = null;
    let startTrust: number | null = null;
    let endTrust: number | null = null;
    let startFollowers: number | null = null;
    let endFollowers: number | null = null;

    for (const step of steps) {
      const envState = step.environmentState || {};

      // Track reputation changes
      const reputation = Number(
        envState.reputation || envState.agentReputation || 0,
      );
      if (reputation !== 0) {
        if (startReputation === null) {
          startReputation = reputation;
        }
        endReputation = reputation;
      }

      // Track trust changes
      const trust = Number(envState.trustLevel || envState.trust || 0);
      if (trust !== 0) {
        if (startTrust === null) {
          startTrust = trust;
        }
        endTrust = trust;
      }

      // Track follower changes
      const followers = Number(
        envState.followers || envState.followerCount || 0,
      );
      if (followers !== 0) {
        if (startFollowers === null) {
          startFollowers = followers;
        }
        endFollowers = followers;
      }

      // Track reactions from action results
      const action = step.action;
      if (action?.result) {
        const result = action.result;
        if (result.likes || result.upvotes) {
          metrics.positiveReactions += Number(
            result.likes || result.upvotes || 0,
          );
        }
        if (result.dislikes || result.downvotes) {
          metrics.negativeReactions += Number(
            result.dislikes || result.downvotes || 0,
          );
        }
        if (result.shares || result.reshares) {
          metrics.informationSpread += Number(
            result.shares || result.reshares || 0,
          );
        }
      }
    }

    // Calculate deltas
    if (startReputation !== null && endReputation !== null) {
      metrics.reputationDelta = endReputation - startReputation;
    }
    if (startTrust !== null && endTrust !== null) {
      metrics.trustLevelDelta = endTrust - startTrust;
    }
    if (startFollowers !== null && endFollowers !== null) {
      metrics.followersGained = endFollowers - startFollowers;
    }

    // Calculate influence score (simple composite)
    metrics.influenceScore =
      metrics.followersGained * 2 +
      metrics.positiveReactions -
      metrics.negativeReactions +
      metrics.informationSpread * 3;

    return metrics;
  }

  /**
   * Extract behavioral pattern metrics
   */
  private extractBehaviorMetrics(steps: TrajectoryStep[]): BehaviorMetrics {
    const metrics: BehaviorMetrics = {
      actionsPerTick: 0,
      socialToTradeRatio: 0,
      avgResponseTime: 0,
      consistencyScore: 0,
      totalActions: 0,
      failedActions: 0,
      actionSuccessRate: 0,
      episodeLength: steps.length,
      actionTypesUsed: [],
      dominantActionType: "",
    };

    const actionTypeCounts = new Map<string, number>();
    let socialActions = 0;
    let tradeActions = 0;

    for (const step of steps) {
      const action = step.action;
      if (!action) continue;

      metrics.totalActions++;
      if (!action.success) {
        metrics.failedActions++;
      }

      const actionType = action.actionType.toLowerCase();

      // Count action types
      actionTypeCounts.set(
        actionType,
        (actionTypeCounts.get(actionType) || 0) + 1,
      );

      // Categorize actions
      if (SOCIAL_ACTION_TYPES.has(actionType)) {
        socialActions++;
      }
      if (TRADING_ACTION_TYPES.has(actionType)) {
        tradeActions++;
      }
    }

    // Calculate derived metrics
    if (steps.length > 0) {
      metrics.actionsPerTick = metrics.totalActions / steps.length;
    }

    if (metrics.totalActions > 0) {
      metrics.actionSuccessRate =
        (metrics.totalActions - metrics.failedActions) / metrics.totalActions;
    }

    if (tradeActions > 0) {
      metrics.socialToTradeRatio = socialActions / tradeActions;
    } else if (socialActions > 0) {
      // No trades but has social actions - use social count as ratio
      // This makes it clear they're social-focused without a magic number
      metrics.socialToTradeRatio = socialActions;
    }
    // If both are 0, ratio stays at 0 (no activity)

    // Find action types used and dominant type
    metrics.actionTypesUsed = Array.from(actionTypeCounts.keys());

    let maxCount = 0;
    for (const [actionType, count] of actionTypeCounts) {
      if (count > maxCount) {
        maxCount = count;
        metrics.dominantActionType = actionType;
      }
    }

    // Calculate consistency score (inverse of variance in action distribution)
    if (metrics.actionTypesUsed.length > 1) {
      const counts = Array.from(actionTypeCounts.values());
      const mean = counts.reduce((sum, c) => sum + c, 0) / counts.length;
      const variance =
        counts.reduce((sum, c) => sum + (c - mean) ** 2, 0) / counts.length;
      // Normalize to 0-1 range (higher = more consistent)
      metrics.consistencyScore = 1 / (1 + Math.sqrt(variance) / mean);
    } else {
      metrics.consistencyScore = 1; // Single action type = perfectly consistent
    }

    return metrics;
  }

  /**
   * Extract information gathering metrics
   */
  private extractInformationMetrics(
    steps: TrajectoryStep[],
  ): InformationMetrics {
    const metrics: InformationMetrics = {
      researchActions: 0,
      newsConsumed: 0,
      marketDataQueries: 0,
      infoRequestsSent: 0,
      infoShared: 0,
      predictionsMade: 0,
      correctPredictions: 0,
      predictionAccuracy: 0,
    };

    for (const step of steps) {
      const action = step.action;
      if (!action) continue;

      const actionType = action.actionType.toLowerCase();

      if (actionType === "research" || actionType === "analyze") {
        metrics.researchActions++;
      } else if (actionType === "read_news" || actionType === "consume_news") {
        metrics.newsConsumed++;
      } else if (
        actionType === "query_market" ||
        actionType === "check_price" ||
        actionType === "get_quote"
      ) {
        metrics.marketDataQueries++;
      } else if (actionType === "request_info" || actionType === "ask") {
        metrics.infoRequestsSent++;
      } else if (actionType === "share_info" || actionType === "share") {
        metrics.infoShared++;
      } else if (actionType === "predict" || actionType === "bet") {
        metrics.predictionsMade++;

        // Check if prediction was correct
        if (action.correctness?.predictionCorrect === true) {
          metrics.correctPredictions++;
        }
      }
    }

    // Calculate prediction accuracy
    if (metrics.predictionsMade > 0) {
      metrics.predictionAccuracy =
        metrics.correctPredictions / metrics.predictionsMade;
    }

    return metrics;
  }

  /**
   * Parse trajectory from database and extract metrics
   */
  extractFromRaw(params: {
    trajectoryId: string;
    agentId: string;
    stepsJson: string;
    scenarioId?: string;
    finalPnL?: number;
  }): BehavioralMetrics | null {
    try {
      const steps = JSON.parse(params.stepsJson) as TrajectoryStep[];

      if (!Array.isArray(steps) || steps.length === 0) {
        logger.warn(
          "Invalid or empty steps array",
          { trajectoryId: params.trajectoryId },
          "MetricsExtractor",
        );
        return null;
      }

      // Get start/end balance from environment state
      const startBalance = steps[0]?.environmentState?.agentBalance;
      const endBalance =
        steps[steps.length - 1]?.environmentState?.agentBalance;

      return this.extract({
        trajectoryId: params.trajectoryId,
        agentId: params.agentId,
        steps,
        scenarioId: params.scenarioId,
        startBalance:
          startBalance !== undefined ? Number(startBalance) : undefined,
        endBalance:
          endBalance !== undefined
            ? Number(endBalance)
            : params.finalPnL !== undefined
              ? (startBalance !== undefined ? Number(startBalance) : 0) +
                params.finalPnL
              : undefined,
      });
    } catch (error) {
      logger.error(
        "Failed to extract metrics",
        {
          trajectoryId: params.trajectoryId,
          error: error instanceof Error ? error.message : String(error),
        },
        "MetricsExtractor",
      );
      return null;
    }
  }
}

/**
 * Singleton instance
 */
export const trajectoryMetricsExtractor = new TrajectoryMetricsExtractor();
