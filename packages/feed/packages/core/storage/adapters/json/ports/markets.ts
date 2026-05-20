/**
 * JSON Market Adapter
 */

import type { MarketPort } from '../../../ports/markets';
import type {
  MarketSnapshotRecord,
  PredictionMarketRecord,
} from '../../../types';
import type { JsonIdGenerator } from '../id-generator';
import type { JsonStorageState } from '../types';

export class JsonMarketAdapter implements MarketPort {
  constructor(
    private state: JsonStorageState,
    private idGen: JsonIdGenerator,
    private onChange: () => void
  ) {}

  async getMarket(id: string): Promise<PredictionMarketRecord | null> {
    return this.state.markets[id] ?? null;
  }

  async getActiveMarkets(): Promise<PredictionMarketRecord[]> {
    return Object.values(this.state.markets).filter((m) => !m.resolved);
  }

  async getMarketsByCategory(
    category: string
  ): Promise<PredictionMarketRecord[]> {
    return Object.values(this.state.markets).filter(
      (m) => m.category === category
    );
  }

  async createMarket(
    market: Omit<PredictionMarketRecord, 'createdAt'>
  ): Promise<PredictionMarketRecord> {
    const record: PredictionMarketRecord = {
      ...market,
      createdAt: new Date(),
    };
    this.state.markets[market.id] = record;
    this.onChange();
    return record;
  }

  async updateMarket(
    id: string,
    updates: Partial<PredictionMarketRecord>
  ): Promise<PredictionMarketRecord> {
    const existing = this.state.markets[id];
    if (!existing) {
      throw new Error(`Market not found: ${id}`);
    }

    const updated: PredictionMarketRecord = {
      ...existing,
      ...updates,
    };
    this.state.markets[id] = updated;
    this.onChange();
    return updated;
  }

  async resolveMarket(id: string, outcome: boolean): Promise<void> {
    const market = this.state.markets[id];
    if (!market) {
      throw new Error(`Market not found: ${id}`);
    }

    market.resolved = true;
    market.outcome = outcome;
    this.onChange();
  }

  async updateMarketShares(
    id: string,
    yesShares: string,
    noShares: string,
    liquidity: string
  ): Promise<void> {
    const market = this.state.markets[id];
    if (!market) {
      throw new Error(`Market not found: ${id}`);
    }

    market.yesShares = yesShares;
    market.noShares = noShares;
    market.liquidity = liquidity;
    this.onChange();
  }

  async getMarketSnapshots(
    marketId: string,
    limit = 100
  ): Promise<MarketSnapshotRecord[]> {
    return this.state.marketSnapshots
      .filter((s) => s.marketId === marketId)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  async recordMarketSnapshot(
    snapshot: Omit<MarketSnapshotRecord, 'id' | 'timestamp'>
  ): Promise<MarketSnapshotRecord> {
    const record: MarketSnapshotRecord = {
      ...snapshot,
      id: this.idGen.generate('snapshot'),
      timestamp: new Date(),
    };
    this.state.marketSnapshots.push(record);
    this.onChange();
    return record;
  }
}
