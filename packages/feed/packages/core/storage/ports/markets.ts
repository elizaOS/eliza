/**
 * Market Storage Port
 *
 * Defines the interface for prediction market data access.
 */

import type { MarketSnapshotRecord, PredictionMarketRecord } from '../types';

export interface MarketPort {
  // Prediction Market Operations
  getMarket(id: string): Promise<PredictionMarketRecord | null>;
  getActiveMarkets(): Promise<PredictionMarketRecord[]>;
  getMarketsByCategory(category: string): Promise<PredictionMarketRecord[]>;
  createMarket(
    market: Omit<PredictionMarketRecord, 'createdAt'>
  ): Promise<PredictionMarketRecord>;
  updateMarket(
    id: string,
    updates: Partial<PredictionMarketRecord>
  ): Promise<PredictionMarketRecord>;
  resolveMarket(id: string, outcome: boolean): Promise<void>;

  // Market shares update (for trading)
  updateMarketShares(
    id: string,
    yesShares: string,
    noShares: string,
    liquidity: string
  ): Promise<void>;

  // Market Snapshots (price history)
  getMarketSnapshots(
    marketId: string,
    limit?: number
  ): Promise<MarketSnapshotRecord[]>;
  recordMarketSnapshot(
    snapshot: Omit<MarketSnapshotRecord, 'id' | 'timestamp'>
  ): Promise<MarketSnapshotRecord>;
}
