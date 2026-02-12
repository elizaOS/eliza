/**
 * Trajectory Metrics Types
 *
 * Comprehensive behavioral metrics extracted from agent trajectories
 * for use in multi-criteria evaluation with LLM-as-judge.
 */

/**
 * Social interaction metrics
 */
export interface SocialMetrics {
  /** Number of group chats the agent joined */
  groupChatsJoined: number;
  /** Number of group chats the agent created */
  groupChatsCreated: number;
  /** Total messages sent in group chats */
  groupMessagesSent: number;
  /** DMs initiated by the agent */
  dmsInitiated: number;
  /** DMs received by the agent */
  dmsReceived: number;
  /** Percentage of received DMs that were replied to (0-1) */
  dmResponseRate: number;
  /** Number of unique users the agent interacted with */
  uniqueUsersInteracted: number;
  /** Social posts created */
  postsCreated: number;
  /** Comments made on others' posts */
  commentsMade: number;
  /** Times the agent @mentioned others */
  mentionsGiven: number;
  /** Times the agent was @mentioned */
  mentionsReceived: number;
  /** Invitations sent to others */
  invitationsSent: number;
}

/**
 * Trading performance metrics
 */
export interface TradingMetrics {
  /** Total number of trades executed */
  tradesExecuted: number;
  /** Number of profitable trades */
  profitableTrades: number;
  /** Win rate as a decimal (0-1) */
  winRate: number;
  /** Final profit/loss in dollars */
  totalPnL: number;
  /** Maximum peak-to-trough drawdown */
  maxDrawdown: number;
  /** Sharpe ratio (risk-adjusted returns) */
  sharpeRatio: number;
  /** Average position size */
  avgPositionSize: number;
  /** Average time holding a position (in ticks) */
  avgHoldingPeriod: number;
  /** Number of unique markets traded */
  marketsTraded: number;
  /** Buy trades */
  buyTrades: number;
  /** Sell trades */
  sellTrades: number;
  /** Largest single win */
  largestWin: number;
  /** Largest single loss */
  largestLoss: number;
}

/**
 * Influence and reputation metrics
 */
export interface InfluenceMetrics {
  /** Net new followers gained */
  followersGained: number;
  /** Change in reputation score */
  reputationDelta: number;
  /** Change in trust level */
  trustLevelDelta: number;
  /** Composite influence score */
  influenceScore: number;
  /** How widely information spread (reshares, etc.) */
  informationSpread: number;
  /** Positive reactions received */
  positiveReactions: number;
  /** Negative reactions received */
  negativeReactions: number;
}

/**
 * Behavioral pattern metrics
 */
export interface BehaviorMetrics {
  /** Average actions taken per game tick */
  actionsPerTick: number;
  /** Ratio of social actions to trading actions */
  socialToTradeRatio: number;
  /** Average time to respond to messages (in ms) */
  avgResponseTime: number;
  /** Consistency of behavior (0-1, higher = more consistent) */
  consistencyScore: number;
  /** Total number of actions taken */
  totalActions: number;
  /** Number of failed actions */
  failedActions: number;
  /** Action success rate (0-1) */
  actionSuccessRate: number;
  /** Episode length in ticks */
  episodeLength: number;
  /** Types of actions used */
  actionTypesUsed: string[];
  /** Most common action type */
  dominantActionType: string;
}

/**
 * Information gathering metrics
 */
export interface InformationMetrics {
  /** Number of research actions taken */
  researchActions: number;
  /** News items read/analyzed */
  newsConsumed: number;
  /** Market data queries made */
  marketDataQueries: number;
  /** Information requests made to others */
  infoRequestsSent: number;
  /** Information shared with others */
  infoShared: number;
  /** Predictions made */
  predictionsMade: number;
  /** Correct predictions */
  correctPredictions: number;
  /** Prediction accuracy (0-1) */
  predictionAccuracy: number;
}

/**
 * Complete behavioral metrics combining all categories
 * Note: Named BehavioralMetrics to avoid conflict with existing TrajectoryMetrics in training/types.ts
 */
export interface BehavioralMetrics {
  /** Social interaction metrics */
  social: SocialMetrics;
  /** Trading performance metrics */
  trading: TradingMetrics;
  /** Influence and reputation metrics */
  influence: InfluenceMetrics;
  /** Behavioral pattern metrics */
  behavior: BehaviorMetrics;
  /** Information gathering metrics */
  information: InformationMetrics;

  /** Timestamp when metrics were extracted */
  extractedAt: Date;
  /** Trajectory ID these metrics belong to */
  trajectoryId: string;
  /** Agent ID */
  agentId: string;
  /** Scenario ID if applicable */
  scenarioId?: string;
}

/**
 * Metrics summary for quick reference
 */
export interface MetricsSummary {
  /** Total P&L */
  totalPnL: number;
  /** Win rate */
  winRate: number;
  /** Total trades */
  tradesExecuted: number;
  /** Unique users interacted */
  uniqueUsersInteracted: number;
  /** Social to trade ratio */
  socialToTradeRatio: number;
  /** Action success rate */
  actionSuccessRate: number;
  /** Reputation change */
  reputationDelta: number;
  /** Episode length */
  episodeLength: number;
}

/**
 * Extract summary from full metrics
 */
export function getMetricsSummary(metrics: BehavioralMetrics): MetricsSummary {
  return {
    totalPnL: metrics.trading.totalPnL,
    winRate: metrics.trading.winRate,
    tradesExecuted: metrics.trading.tradesExecuted,
    uniqueUsersInteracted: metrics.social.uniqueUsersInteracted,
    socialToTradeRatio: metrics.behavior.socialToTradeRatio,
    actionSuccessRate: metrics.behavior.actionSuccessRate,
    reputationDelta: metrics.influence.reputationDelta,
    episodeLength: metrics.behavior.episodeLength,
  };
}
