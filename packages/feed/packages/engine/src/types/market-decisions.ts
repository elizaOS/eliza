/**
 * Market Decision Types
 *
 * Types for LLM-driven NPC trading decisions
 */

export type MarketAction =
  | "open_long"
  | "open_short"
  | "buy_yes"
  | "buy_no"
  | "sell_yes"
  | "sell_no"
  | "close_position"
  | "hold"
  | "wait";

export type MarketType = "perp" | "prediction";

export interface TradingDecision {
  npcId: string;
  npcName: string;
  action: MarketAction;
  marketType: MarketType | null;
  ticker?: string;
  marketId?: string; // Market ID is a Snowflake string
  positionId?: string;
  amount: number;
  /** For close_position on perps, close only this portion (0-1). Omitted means full close. */
  closePercentage?: number;
  confidence: number;
  reasoning: string;
  timestamp?: string;
}

export interface ExecutedTrade {
  npcId: string;
  npcName: string;
  poolId: string;
  marketType: MarketType;
  ticker?: string;
  marketId?: string; // Market ID is a Snowflake string
  action: MarketAction;
  side: string;
  amount: number;
  size: number;
  shares?: number;
  executionPrice: number;
  confidence: number;
  reasoning: string;
  positionId: string;
  timestamp: string;
}

export interface TradingExecutionResult {
  totalDecisions: number;
  successfulTrades: number;
  failedTrades: number;
  holdDecisions: number;
  totalVolumePerp: number;
  totalVolumePrediction: number;
  errors: Array<{
    npcId: string;
    decision: TradingDecision;
    error: string;
  }>;
  executedTrades: ExecutedTrade[];
}

export interface TradeImpact {
  ticker?: string;
  marketId?: string; // Market ID is a Snowflake string
  longVolume: number;
  shortVolume: number;
  yesVolume: number;
  noVolume: number;
  netSentiment: number;
  priceImpact: number;
}
