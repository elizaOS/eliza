/**
 * Agent Goals, Directives, and Constraints Type Definitions
 *
 * Defines the structure for user-configurable agent goals and autonomous behavior.
 */

import type { JsonValue } from "./common";

/**
 * Agent Goal Types
 */
export type GoalType =
  | "trading"
  | "social"
  | "learning"
  | "reputation"
  | "custom";
export type GoalStatus = "active" | "paused" | "completed" | "failed";

/**
 * Goal Target Metrics
 */
export interface GoalTarget {
  metric:
    | "pnl" // Profit & Loss target
    | "balance" // Balance target
    | "followers" // Follower count
    | "posts" // Number of posts
    | "comments" // Number of comments
    | "win_rate" // Trading win rate
    | "trades" // Number of trades
    | "engagement" // Social engagement score
    | "reputation" // Reputation points
    | "custom"; // Custom metric
  value: number; // Target value
  current?: number; // Current value
  deadline?: Date; // Optional deadline
  unit?: string; // Unit for display (e.g., "$", "%", "followers")
}

/**
 * Complete Agent Goal Definition
 */
export interface AgentGoal {
  id: string;
  agentUserId: string;
  type: GoalType;
  name: string;
  description: string;
  target?: GoalTarget;
  priority: number; // 1-10, higher = more important
  status: GoalStatus;
  progress: number; // 0-1 (0% to 100%)
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;

  // Optional configuration
  constraints?: Partial<AgentConstraints>;
  rewards?: {
    onProgress?: string;
    onCompletion?: string;
  };
}

/**
 * Directive Types
 */
export type DirectiveType =
  | "always" // Must always do
  | "never" // Must never do
  | "prefer" // Should prefer
  | "avoid"; // Should avoid

/**
 * Agent Directive Definition
 */
export interface AgentDirective {
  id: string;
  type: DirectiveType;
  rule: string; // Short rule statement
  description: string; // Detailed explanation
  priority: number; // 1-10
  examples: string[]; // Example scenarios
  contexts?: string[]; // When this applies (e.g., ['trading', 'social'])
}

/**
 * Trading Constraints
 */
export interface TradingConstraints {
  maxPositionSize: number; // Max $ per position
  maxLeverage: number; // Max leverage multiplier
  maxOpenPositions?: number; // Max concurrent positions
  allowedMarketTypes: ("prediction" | "perp")[];
  stopLossPercent?: number; // Auto stop-loss %
  takeProfitPercent?: number; // Auto take-profit %
  allowedTickers?: string[]; // Whitelist of tickers
  forbiddenTickers?: string[]; // Blacklist of tickers
  minConfidence?: number; // Min confidence for trades (0-1)
  maxDailyTrades?: number; // Max trades per day
}

/**
 * Social Constraints
 */
export interface SocialConstraints {
  minPostInterval: number; // Minutes between posts
  maxPostsPerDay: number; // Max posts in 24h
  maxCommentsPerDay?: number; // Max comments in 24h
  allowedTopics?: string[]; // Topic whitelist
  restrictedTopics?: string[]; // Topic blacklist
  minPostLength?: number; // Min characters
  maxPostLength?: number; // Max characters
  requireApproval?: boolean; // Require manager approval
  allowMentions?: boolean; // Can mention other users
  allowHashtags?: boolean; // Can use hashtags
}

/**
 * General Behavior Constraints
 */
export interface GeneralConstraints {
  maxActionsPerTick: number; // Max actions in one tick
  priorityWeights: {
    trading: number; // Weight for trading actions
    social: number; // Weight for social actions
    responding: number; // Weight for responses
  };
  respectQuietHours?: boolean; // Follow quiet hours
  quietHoursStart?: number; // Hour (0-23)
  quietHoursEnd?: number; // Hour (0-23)
  riskTolerance: "low" | "medium" | "high"; // Overall risk appetite
}

/**
 * Complete Constraints Configuration
 */
export interface AgentConstraints {
  trading: TradingConstraints;
  social: SocialConstraints;
  general: GeneralConstraints;
}

/**
 * Agent Planning Configuration
 */
export interface PlanningConfig {
  horizon: "single" | "multi"; // Single or multi-action planning
  lookAhead: number; // How many ticks to consider
  maxActionsPerPlan: number; // Max actions in one plan
  replanInterval?: number; // Re-plan every N ticks
}

/**
 * Goal Progress Update
 */
export interface GoalProgressUpdate {
  goalId: string;
  actionType: string;
  actionId?: string;
  impact: number; // How much progress (0-1)
  metadata?: Record<string, JsonValue>;
}

/**
 * Goal Template (for quick setup)
 */
export interface GoalTemplate {
  type: GoalType;
  name: string;
  description: string;
  defaultTarget: GoalTarget;
  suggestedPriority: number;
  suggestedDirectives: AgentDirective[];
  suggestedConstraints: Partial<AgentConstraints>;
}

/**
 * Pre-defined Goal Templates
 */
export const GOAL_TEMPLATES: Record<string, GoalTemplate> = {
  PROFIT_TRADER: {
    type: "trading",
    name: "Profit Maximization",
    description:
      "Focus on maximizing trading profits through smart market decisions",
    defaultTarget: {
      metric: "pnl",
      value: 1000,
      unit: "$",
    },
    suggestedPriority: 10,
    suggestedDirectives: [
      {
        id: "always_cut_losses",
        type: "always",
        rule: "Cut losses when position down >10%",
        description: "Exit losing positions to preserve capital",
        priority: 9,
        examples: [
          "Exit if position shows -10% loss",
          "Set stop-loss on all trades",
        ],
      },
      {
        id: "never_overtrade",
        type: "never",
        rule: "Never use more than 50% of balance on single trade",
        description: "Preserve capital by diversifying",
        priority: 10,
        examples: ["Max $500 per trade if balance is $1000"],
      },
    ],
    suggestedConstraints: {
      trading: {
        maxPositionSize: 500,
        maxLeverage: 3,
        maxOpenPositions: 5,
        allowedMarketTypes: ["prediction", "perp"],
        stopLossPercent: 10,
        takeProfitPercent: 20,
      },
      general: {
        maxActionsPerTick: 3,
        priorityWeights: {
          trading: 0.8,
          social: 0.1,
          responding: 0.1,
        },
        riskTolerance: "high",
      },
    },
  },

  SOCIAL_INFLUENCER: {
    type: "social",
    name: "Social Growth",
    description: "Build following and engagement through quality content",
    defaultTarget: {
      metric: "followers",
      value: 100,
      unit: "followers",
    },
    suggestedPriority: 10,
    suggestedDirectives: [
      {
        id: "always_engage",
        type: "always",
        rule: "Respond to comments on your posts",
        description: "Build community through engagement",
        priority: 8,
        examples: ["Reply to thoughtful comments", "Thank supporters"],
      },
      {
        id: "prefer_quality",
        type: "prefer",
        rule: "Prefer quality over quantity in posts",
        description: "Focus on valuable, insightful content",
        priority: 9,
        examples: ["Share market analysis", "Provide helpful tips"],
      },
    ],
    suggestedConstraints: {
      social: {
        minPostInterval: 60,
        maxPostsPerDay: 10,
        maxCommentsPerDay: 50,
        minPostLength: 50,
        maxPostLength: 280,
        allowMentions: true,
        allowHashtags: true,
      },
      general: {
        maxActionsPerTick: 5,
        priorityWeights: {
          trading: 0.1,
          social: 0.7,
          responding: 0.2,
        },
        riskTolerance: "medium",
      },
    },
  },

  BALANCED_AGENT: {
    type: "custom",
    name: "Balanced Growth",
    description: "Balance trading profits with social engagement",
    defaultTarget: {
      metric: "custom",
      value: 100,
      unit: "points",
    },
    suggestedPriority: 8,
    suggestedDirectives: [
      {
        id: "balanced_approach",
        type: "prefer",
        rule: "Balance trading and social activities",
        description: "Maintain presence in both domains",
        priority: 7,
        examples: ["Trade 2-3 times per day", "Post 1-2 times per day"],
      },
    ],
    suggestedConstraints: {
      trading: {
        maxPositionSize: 300,
        maxLeverage: 2,
        allowedMarketTypes: ["prediction", "perp"],
        stopLossPercent: 15,
      },
      social: {
        minPostInterval: 120,
        maxPostsPerDay: 5,
        minPostLength: 30,
        maxPostLength: 280,
      },
      general: {
        maxActionsPerTick: 4,
        priorityWeights: {
          trading: 0.4,
          social: 0.3,
          responding: 0.3,
        },
        riskTolerance: "medium",
      },
    },
  },
};

/**
 * Default constraints for new agents
 */
export const DEFAULT_CONSTRAINTS: AgentConstraints = {
  trading: {
    maxPositionSize: 100,
    maxLeverage: 2,
    maxOpenPositions: 3,
    allowedMarketTypes: ["prediction", "perp"],
    stopLossPercent: 20,
    maxDailyTrades: 10,
  },
  social: {
    minPostInterval: 30,
    maxPostsPerDay: 10,
    maxCommentsPerDay: 20,
    minPostLength: 20,
    maxPostLength: 280,
    allowMentions: true,
    allowHashtags: true,
  },
  general: {
    maxActionsPerTick: 3,
    priorityWeights: {
      trading: 0.33,
      social: 0.33,
      responding: 0.34,
    },
    riskTolerance: "medium",
  },
};
