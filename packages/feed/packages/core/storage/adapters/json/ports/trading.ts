/**
 * JSON Trading Adapter
 */

import type { TradingPort } from '../../../ports/trading';
import type {
  NpcTradeRecord,
  PoolPositionRecord,
  PoolRecord,
} from '../../../types';
import type { JsonIdGenerator } from '../id-generator';
import type { JsonStorageState } from '../types';

export class JsonTradingAdapter implements TradingPort {
  constructor(
    private state: JsonStorageState,
    private idGen: JsonIdGenerator,
    private onChange: () => void
  ) {}

  async getPool(id: string): Promise<PoolRecord | null> {
    return this.state.pools[id] ?? null;
  }

  async getPoolByActorId(actorId: string): Promise<PoolRecord | null> {
    return (
      Object.values(this.state.pools).find((p) => p.npcActorId === actorId) ??
      null
    );
  }

  async createPool(
    pool: Omit<PoolRecord, 'openedAt' | 'updatedAt'>
  ): Promise<PoolRecord> {
    const now = new Date();
    const record: PoolRecord = {
      ...pool,
      openedAt: now,
      updatedAt: now,
    };
    this.state.pools[pool.id] = record;
    this.onChange();
    return record;
  }

  async updatePool(
    id: string,
    updates: Partial<PoolRecord>
  ): Promise<PoolRecord> {
    const pool = this.state.pools[id];
    if (!pool) {
      throw new Error(`Pool not found: ${id}`);
    }

    Object.assign(pool, updates, { updatedAt: new Date() });
    this.onChange();
    return pool;
  }

  async getPosition(id: string): Promise<PoolPositionRecord | null> {
    return this.state.positions[id] ?? null;
  }

  async getOpenPositions(poolId: string): Promise<PoolPositionRecord[]> {
    return Object.values(this.state.positions).filter(
      (p) => p.poolId === poolId && !p.closedAt
    );
  }

  async getOpenPositionsByMarket(
    marketId: string
  ): Promise<PoolPositionRecord[]> {
    return Object.values(this.state.positions).filter(
      (p) => p.marketId === marketId && !p.closedAt
    );
  }

  async getOpenPositionsByTicker(
    ticker: string
  ): Promise<PoolPositionRecord[]> {
    return Object.values(this.state.positions).filter(
      (p) => p.ticker === ticker && !p.closedAt
    );
  }

  async createPosition(
    position: Omit<PoolPositionRecord, 'updatedAt'>
  ): Promise<PoolPositionRecord> {
    const record: PoolPositionRecord = {
      ...position,
      updatedAt: new Date(),
    };
    this.state.positions[position.id] = record;
    this.onChange();
    return record;
  }

  async updatePosition(
    id: string,
    updates: Partial<PoolPositionRecord>
  ): Promise<PoolPositionRecord> {
    const position = this.state.positions[id];
    if (!position) {
      throw new Error(`Position not found: ${id}`);
    }

    Object.assign(position, updates, { updatedAt: new Date() });
    this.onChange();
    return position;
  }

  async closePosition(
    id: string,
    realizedPnL: number
  ): Promise<PoolPositionRecord> {
    const position = this.state.positions[id];
    if (!position) {
      throw new Error(`Position not found: ${id}`);
    }

    position.closedAt = new Date();
    position.realizedPnL = realizedPnL;
    position.unrealizedPnL = 0;
    position.updatedAt = new Date();
    this.onChange();
    return position;
  }

  async getNpcTrades(
    npcActorId: string,
    limit = 100
  ): Promise<NpcTradeRecord[]> {
    return this.state.npcTrades
      .filter((t) => t.npcActorId === npcActorId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async createNpcTrade(
    trade: Omit<NpcTradeRecord, 'id' | 'createdAt'>
  ): Promise<NpcTradeRecord> {
    const record: NpcTradeRecord = {
      ...trade,
      id: this.idGen.generate('trade'),
      createdAt: new Date(),
    };
    this.state.npcTrades.push(record);
    this.onChange();
    return record;
  }

  async getRecentNpcTrades(limit = 100): Promise<NpcTradeRecord[]> {
    return this.state.npcTrades
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
}
