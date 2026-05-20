/**
 * Game Storage Port
 *
 * Defines the interface for game state and world event data access.
 */

import type { GameRecord, StockPriceRecord, WorldEventRecord } from '../types';

export interface GamePort {
  // Game State Operations
  getGameState(): Promise<GameRecord | null>;
  initializeGame(): Promise<GameRecord>;
  updateGameState(updates: Partial<GameRecord>): Promise<GameRecord>;
  getAllGames(): Promise<GameRecord[]>;

  // World Events
  getRecentEvents(limit?: number): Promise<WorldEventRecord[]>;
  createEvent(
    event: Omit<WorldEventRecord, 'timestamp'>
  ): Promise<WorldEventRecord>;
  getEventsByDay(day: number): Promise<WorldEventRecord[]>;

  // Stock Prices
  recordPriceUpdate(
    organizationId: string,
    price: number,
    change: number,
    changePercent: number
  ): Promise<StockPriceRecord>;
  recordDailySnapshot(
    organizationId: string,
    data: {
      openPrice: number;
      highPrice: number;
      lowPrice: number;
      closePrice: number;
      volume: number;
    }
  ): Promise<StockPriceRecord>;
  getPriceHistory(
    organizationId: string,
    limit?: number
  ): Promise<StockPriceRecord[]>;
  getDailySnapshots(
    organizationId: string,
    days?: number
  ): Promise<StockPriceRecord[]>;
}
