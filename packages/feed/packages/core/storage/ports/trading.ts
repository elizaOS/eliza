/**
 * Trading Storage Port
 *
 * Defines the interface for trading-related data access.
 */

import type { NpcTradeRecord, PoolPositionRecord, PoolRecord } from "../types";

export interface TradingPort {
  // Pool Operations
  getPool(id: string): Promise<PoolRecord | null>;
  getPoolByActorId(actorId: string): Promise<PoolRecord | null>;
  createPool(
    pool: Omit<PoolRecord, "openedAt" | "updatedAt">,
  ): Promise<PoolRecord>;
  updatePool(id: string, updates: Partial<PoolRecord>): Promise<PoolRecord>;

  // Position Operations
  getPosition(id: string): Promise<PoolPositionRecord | null>;
  getOpenPositions(poolId: string): Promise<PoolPositionRecord[]>;
  getOpenPositionsByMarket(marketId: string): Promise<PoolPositionRecord[]>;
  getOpenPositionsByTicker(ticker: string): Promise<PoolPositionRecord[]>;
  createPosition(
    position: Omit<PoolPositionRecord, "updatedAt">,
  ): Promise<PoolPositionRecord>;
  updatePosition(
    id: string,
    updates: Partial<PoolPositionRecord>,
  ): Promise<PoolPositionRecord>;
  closePosition(id: string, realizedPnL: number): Promise<PoolPositionRecord>;

  // NPC Trade Operations
  getNpcTrades(npcActorId: string, limit?: number): Promise<NpcTradeRecord[]>;
  createNpcTrade(
    trade: Omit<NpcTradeRecord, "id" | "createdAt">,
  ): Promise<NpcTradeRecord>;
  getRecentNpcTrades(limit?: number): Promise<NpcTradeRecord[]>;
}
