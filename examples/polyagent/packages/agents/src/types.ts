/**
 * Type definitions for Polyagent Agent System
 */

import type { Character } from "@elizaos/core";
import type { JsonValue } from "./types/common";

// Re-export all types from types/index.ts for backwards compatibility
export * from "./types/index";

export interface AgentConfig {
  id: string;
  userId: string;
  name: string;
  description?: string;
  profileImageUrl?: string;

  // Character configuration
  character: Character;

  // Runtime config
  modelTier: "lite" | "standard" | "pro";
  autonomousEnabled: boolean;
  isActive: boolean;

  // Wallet
  walletAddress?: string;
  privyWalletId?: string;

  // Performance
  lifetimePnL: number;
  totalTrades: number;
  winRate: number;
}

export interface AgentMessage {
  id: string;
  agentId: string;
  role: "user" | "assistant" | "system";
  content: string;
  modelUsed?: string;
  pointsCost: number;
  metadata?: Record<string, JsonValue>;
  createdAt: Date;
}

export interface AgentLog {
  id: string;
  agentId: string;
  type: "chat" | "tick" | "trade" | "error" | "system";
  level: "info" | "warn" | "error" | "debug";
  message: string;
  prompt?: string;
  completion?: string;
  thinking?: string;
  metadata?: Record<string, JsonValue>;
  createdAt: Date;
}

export interface AgentPointsTransaction {
  id: string;
  agentId: string;
  userId: string;
  type: "deposit" | "withdraw" | "spend_chat" | "spend_tick" | "earn_trade";
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  description: string;
  relatedId?: string;
  createdAt: Date;
}

export interface AgentTrade {
  id: string;
  agentId: string;
  userId: string;
  marketType: "prediction" | "perp";
  marketId?: string;
  ticker?: string;
  action: "open" | "close";
  side?: "long" | "short" | "yes" | "no";
  amount: number;
  price: number;
  pnl?: number;
  reasoning?: string;
  executedAt: Date;
}

export interface CreateAgentParams {
  userId: string;
  name: string;
  username?: string; // Optional: if not provided, will be auto-generated
  description?: string;
  profileImageUrl?: string;
  coverImageUrl?: string;
  system: string;
  bio?: string[];
  personality?: string;
  tradingStrategy?: string;
  initialDeposit?: number;
  modelTier?: "lite" | "standard" | "pro";
}

export interface ChatRequest {
  agentId: string;
  userId: string;
  message: string;
  usePro?: boolean;
}

export interface ChatResponse {
  messageId: string;
  response: string;
  pointsCost: number;
  modelUsed: string;
  balanceAfter: number;
}

export interface AgentPerformance {
  lifetimePnL: number;
  totalTrades: number;
  profitableTrades: number;
  winRate: number;
  avgTradeSize: number;
  sharpeRatio?: number;
  maxDrawdown?: number;
}
