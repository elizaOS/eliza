/**
 * JSON Game Adapter
 */

import type { GamePort } from '../../../ports/game';
import type {
  GameRecord,
  StockPriceRecord,
  WorldEventRecord,
} from '../../../types';
import type { JsonIdGenerator } from '../id-generator';
import type { JsonStorageState } from '../types';

export class JsonGameAdapter implements GamePort {
  constructor(
    private state: JsonStorageState,
    private idGen: JsonIdGenerator,
    private onChange: () => void
  ) {}

  async getGameState(): Promise<GameRecord | null> {
    return this.state.game;
  }

  async initializeGame(): Promise<GameRecord> {
    if (this.state.game) {
      return this.state.game;
    }

    const now = new Date();
    const game: GameRecord = {
      id: this.idGen.generate('game'),
      isContinuous: true,
      isRunning: true,
      currentDay: 1,
      currentDate: now,
      speed: 60000,
      createdAt: now,
      updatedAt: now,
    };

    this.state.game = game;
    this.onChange();
    return game;
  }

  async updateGameState(updates: Partial<GameRecord>): Promise<GameRecord> {
    if (!this.state.game) {
      throw new Error('Game not initialized');
    }

    this.state.game = {
      ...this.state.game,
      ...updates,
      updatedAt: new Date(),
    };
    this.onChange();
    return this.state.game;
  }

  async getAllGames(): Promise<GameRecord[]> {
    return this.state.game ? [this.state.game] : [];
  }

  async getRecentEvents(limit = 100): Promise<WorldEventRecord[]> {
    return this.state.worldEvents
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  async createEvent(
    event: Omit<WorldEventRecord, 'timestamp'>
  ): Promise<WorldEventRecord> {
    const record: WorldEventRecord = {
      ...event,
      timestamp: new Date(),
    };
    this.state.worldEvents.push(record);
    this.onChange();
    return record;
  }

  async getEventsByDay(day: number): Promise<WorldEventRecord[]> {
    return this.state.worldEvents.filter((e) => e.dayNumber === day);
  }

  async recordPriceUpdate(
    organizationId: string,
    price: number,
    change: number,
    changePercent: number
  ): Promise<StockPriceRecord> {
    const record: StockPriceRecord = {
      id: this.idGen.generate('price'),
      organizationId,
      price,
      change,
      changePercent,
      isSnapshot: false,
      timestamp: new Date(),
    };
    this.state.stockPrices.push(record);
    this.onChange();
    return record;
  }

  async recordDailySnapshot(
    organizationId: string,
    data: {
      openPrice: number;
      highPrice: number;
      lowPrice: number;
      closePrice: number;
      volume: number;
    }
  ): Promise<StockPriceRecord> {
    const record: StockPriceRecord = {
      id: this.idGen.generate('price'),
      organizationId,
      price: data.closePrice,
      change: data.closePrice - data.openPrice,
      changePercent:
        ((data.closePrice - data.openPrice) / data.openPrice) * 100,
      isSnapshot: true,
      openPrice: data.openPrice,
      highPrice: data.highPrice,
      lowPrice: data.lowPrice,
      volume: data.volume,
      timestamp: new Date(),
    };
    this.state.stockPrices.push(record);
    this.onChange();
    return record;
  }

  async getPriceHistory(
    organizationId: string,
    limit = 1440
  ): Promise<StockPriceRecord[]> {
    return this.state.stockPrices
      .filter((p) => p.organizationId === organizationId)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  async getDailySnapshots(
    organizationId: string,
    days = 30
  ): Promise<StockPriceRecord[]> {
    return this.state.stockPrices
      .filter((p) => p.organizationId === organizationId && p.isSnapshot)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, days);
  }
}
