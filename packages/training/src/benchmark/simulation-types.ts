import type { JsonValue } from "../adapter";

export type AgentActionType =
  | "query_state"
  | "buy_prediction"
  | "sell_prediction"
  | "open_perp"
  | "close_perp"
  | "create_post"
  | "join_group"
  | "send_message";

export interface AgentAction {
  tick: number;
  timestamp: number;
  type: AgentActionType;
  data: Record<string, JsonValue>;
  /** How long agent took to respond in milliseconds */
  duration: number;
  correctness?: {
    /** Prediction market correctness tracking */
    predictionCorrect?: boolean;
    actualOutcome?: boolean;
    predictedOutcome?: boolean;

    /** Perpetual trade correctness tracking */
    perpCorrect?: boolean;
    sentimentAtTrade?: number;
    priceChange?: number;
    expectedDirection?: "up" | "down";

    /** Sentiment analysis accuracy tracking */
    sentimentAccuracy?: number;
    sentimentAtTime?: number;
    actualSentiment?: number;
  };
}

export interface SimulationMetrics {
  /** Total P&L from all positions */
  totalPnl: number;

  /** Prediction market metrics */
  predictionMetrics: {
    totalPositions: number;
    correctPredictions: number;
    incorrectPredictions: number;
    accuracy: number;
    avgPnlPerPosition: number;
  };

  /** Perpetual trading metrics */
  perpMetrics: {
    totalTrades: number;
    profitableTrades: number;
    winRate: number;
    avgPnlPerTrade: number;
    maxDrawdown: number;
  };

  /** Social metrics */
  socialMetrics: {
    postsCreated: number;
    groupsJoined: number;
    messagesReceived: number;
    reputationGained: number;
  };

  /** Timing metrics */
  timing: {
    avgResponseTime: number;
    maxResponseTime: number;
    totalDuration: number;
  };

  /** Compared to optimal actions */
  optimalityScore: number; // 0-100, how close to optimal
}
