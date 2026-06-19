/**
 * Agent Storage Port
 *
 * Defines the interface for agent data access.
 * Agents are AI-powered users that can trade, post, and interact.
 */

import type {
  AgentConfigRecord,
  AgentTradeRecord,
  JsonValue,
  PaginationOptions,
} from "../types";

export interface AgentLogRecord {
  id: string;
  agentUserId: string;
  type:
    | "chat"
    | "tick"
    | "trade"
    | "error"
    | "system"
    | "post"
    | "comment"
    | "dm";
  level: "info" | "warn" | "error" | "debug";
  message: string;
  prompt?: string;
  completion?: string;
  thinking?: string;
  metadata?: Record<string, JsonValue>;
  createdAt: Date;
}

export interface AgentMessageRecord {
  id: string;
  agentUserId: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: Record<string, JsonValue>;
  createdAt: Date;
}

export interface AgentPointsTransactionRecord {
  id: string;
  agentUserId: string;
  managerUserId: string;
  type:
    | "deposit"
    | "withdraw"
    | "spend_chat"
    | "spend_post"
    | "spend_tick"
    | "earn";
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  description?: string;
  relatedId?: string;
  createdAt: Date;
}

export interface AgentPort {
  // Agent Config Operations
  getAgentConfig(userId: string): Promise<AgentConfigRecord | null>;
  createAgentConfig(
    config: Omit<AgentConfigRecord, "updatedAt">,
  ): Promise<AgentConfigRecord>;
  updateAgentConfig(
    userId: string,
    updates: Partial<AgentConfigRecord>,
  ): Promise<AgentConfigRecord>;
  deleteAgentConfig(userId: string): Promise<void>;

  // Agent Logs
  getAgentLogs(
    agentUserId: string,
    options?: PaginationOptions & { type?: string; level?: string },
  ): Promise<AgentLogRecord[]>;
  createAgentLog(
    log: Omit<AgentLogRecord, "id" | "createdAt">,
  ): Promise<AgentLogRecord>;

  // Agent Messages (chat history)
  getAgentMessages(
    agentUserId: string,
    limit?: number,
  ): Promise<AgentMessageRecord[]>;
  createAgentMessage(
    message: Omit<AgentMessageRecord, "id" | "createdAt">,
  ): Promise<AgentMessageRecord>;

  // Agent Points Transactions
  getAgentPointsTransactions(
    agentUserId: string,
    limit?: number,
  ): Promise<AgentPointsTransactionRecord[]>;
  createAgentPointsTransaction(
    transaction: Omit<AgentPointsTransactionRecord, "id" | "createdAt">,
  ): Promise<AgentPointsTransactionRecord>;

  // Agent Trades
  getAgentTrades(
    agentUserId: string,
    limit?: number,
  ): Promise<AgentTradeRecord[]>;
  createAgentTrade(
    trade: Omit<AgentTradeRecord, "id" | "createdAt">,
  ): Promise<AgentTradeRecord>;

  // Listing agents with autonomous trading enabled
  listAgentsWithAutonomousTrading(): Promise<AgentConfigRecord[]>;
}
