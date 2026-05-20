/**
 * Simulation Game Adapter
 *
 * Bridges the harness A2AClientInterface with the engine's InMemoryStateStore.
 * Provides a complete simulation environment with no server or database required.
 *
 * @example
 * ```typescript
 * import { SimulationAdapter } from '@babylon/agent-harness';
 *
 * const adapter = new SimulationAdapter({
 *   numPredictionMarkets: 5,
 *   numPerpMarkets: 8,
 *   numAgents: 20,
 *   seed: 12345
 * });
 *
 * // Now use adapter for training
 * while (!adapter.isComplete()) {
 *   const portfolio = await adapter.getPortfolio();
 *   const markets = await adapter.getMarkets();
 *   // Make decision...
 *   adapter.tick();
 * }
 * ```
 */

import { InMemoryStateStore, type SimulationConfig } from '@babylon/engine';
import type {
  A2AClientInterface,
  AgentInfo,
  LeaderboardEntry,
  Market,
  Notification,
  Position,
  Post,
  SystemStats,
  Trade,
  UserInfo,
} from './types';

// Re-export types for convenience
export type { SimulationConfig };

export interface SimulationTickResult {
  tick: number;
  day: number;
  hour: number;
}

/**
 * Adapter that implements A2AClientInterface using InMemoryStateStore
 *
 * This provides a complete simulation environment:
 * - No server required
 * - No database required
 * - Deterministic with seed
 * - Full game simulation with markets, agents, posts
 */
export class SimulationAdapter implements A2AClientInterface {
  private store: InMemoryStateStore;
  private userId: string;

  constructor(config: SimulationConfig & { userId?: string } = {}) {
    this.store = new InMemoryStateStore(config);
    this.userId = config.userId ?? `user-${Date.now()}`;
  }

  getUserId(): string {
    return this.userId;
  }

  // ===== Portfolio =====

  async getBalance(): Promise<{ balance: number; currency: string }> {
    const user = this.store.getOrCreateUser(this.userId);
    return { balance: user.balance, currency: 'USD' };
  }

  async getPositions(): Promise<{ positions: Position[] }> {
    const user = this.store.getOrCreateUser(this.userId);
    const state = this.store.getState();

    const positions: Position[] = [];

    for (const pos of user.predictionPositions) {
      const market = state.predictionMarkets.find((m) => m.id === pos.marketId);
      const currentPrice = market
        ? pos.outcome === 'YES'
          ? market.yesPrice
          : market.noPrice
        : pos.avgPrice;

      positions.push({
        id: pos.id,
        marketId: pos.marketId,
        outcome: pos.outcome,
        shares: pos.shares,
        avgPrice: pos.avgPrice,
        currentPrice,
        pnl: (currentPrice - pos.avgPrice) * pos.shares,
      });
    }

    return { positions };
  }

  async getPortfolio(): Promise<{
    balance: number;
    positions: Position[];
    pnl: number;
  }> {
    const { balance } = await this.getBalance();
    const { positions } = await this.getPositions();
    const pnl = positions.reduce((sum, p) => sum + (p.pnl ?? 0), 0);
    return { balance, positions, pnl };
  }

  // ===== Markets =====

  async getMarkets(): Promise<{ predictions: Market[]; perps: Market[] }> {
    const state = this.store.getState();

    const predictions: Market[] = state.predictionMarkets
      .filter((m) => !m.resolved)
      .map((m) => ({
        id: m.id,
        question: m.question,
        description: m.description,
        yesPrice: m.yesPrice,
        noPrice: m.noPrice,
        status: 'active',
      }));

    const perps: Market[] = state.perpMarkets.map((m) => ({
      id: m.ticker,
      question: `${m.name} (${m.ticker})`,
      description: `Price: $${m.price.toFixed(2)} | 24h: ${m.priceChange24h.toFixed(2)}%`,
      yesPrice: m.price,
      noPrice: 0,
      status: 'active',
    }));

    return { predictions, perps };
  }

  async getMarketData(marketId: string): Promise<Market> {
    const state = this.store.getState();

    const predMarket = state.predictionMarkets.find((m) => m.id === marketId);
    if (predMarket) {
      return {
        id: predMarket.id,
        question: predMarket.question,
        description: predMarket.description,
        yesPrice: predMarket.yesPrice,
        noPrice: predMarket.noPrice,
        status: predMarket.resolved ? 'resolved' : 'active',
      };
    }

    const perpMarket = state.perpMarkets.find((m) => m.ticker === marketId);
    if (perpMarket) {
      return {
        id: perpMarket.ticker,
        question: perpMarket.name,
        yesPrice: perpMarket.price,
        noPrice: 0,
        status: 'active',
      };
    }

    throw new Error(`Market ${marketId} not found`);
  }

  async buyShares(
    marketId: string,
    outcome: 'YES' | 'NO',
    amount: number
  ): Promise<Trade> {
    const result = this.store.buyPredictionShares(
      this.userId,
      marketId,
      outcome,
      amount
    );

    if (!result.success) {
      throw new Error(result.error ?? 'Failed to buy shares');
    }

    return {
      id: `trade-${Date.now()}`,
      marketId,
      outcome,
      shares: result.shares ?? 0,
      price: result.price ?? 0,
      totalCost: result.totalCost ?? amount,
    };
  }

  async sellShares(
    marketId: string,
    outcome: 'YES' | 'NO',
    shares: number
  ): Promise<Trade> {
    const result = this.store.sellPredictionShares(
      this.userId,
      marketId,
      outcome,
      shares
    );

    if (!result.success) {
      throw new Error(result.error ?? 'Failed to sell shares');
    }

    return {
      id: `trade-${Date.now()}`,
      marketId,
      outcome,
      shares: result.shares ?? shares,
      price: result.price ?? 0,
      totalCost: result.totalCost ?? 0,
    };
  }

  // ===== Social =====

  async getFeed(limit = 20): Promise<{ posts: Post[] }> {
    const allPosts = this.store.getPosts();

    const posts = allPosts
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((p) => ({
        id: p.id,
        content: p.content,
        authorId: p.authorId,
        authorName: p.authorName,
        likesCount: p.likes,
        createdAt: new Date(p.createdAt).toISOString(),
      }));

    return { posts };
  }

  async createPost(content: string): Promise<Post> {
    const post = this.store.createUserPost(this.userId, content);

    return {
      id: post.id,
      content: post.content,
      authorId: post.authorId,
      authorName: post.authorName,
      likesCount: post.likes,
      createdAt: new Date(post.createdAt).toISOString(),
    };
  }

  async likePost(
    postId: string
  ): Promise<{ success: boolean; likesCount: number }> {
    const posts = this.store.getPosts();
    const post = posts.find((p) => p.id === postId);

    if (post) {
      post.likes++;
      return { success: true, likesCount: post.likes };
    }

    return { success: false, likesCount: 0 };
  }

  async commentPost(postId: string, _content: string): Promise<{ id: string }> {
    return { id: `comment-${Date.now()}-${postId.slice(-4)}` };
  }

  // ===== Discovery =====

  async discover(): Promise<{ agents: AgentInfo[] }> {
    const state = this.store.getState();

    return {
      agents: state.agents.map((a) => ({
        id: a.id,
        name: a.name,
        walletAddress: `0x${a.id.slice(-40).padStart(40, '0')}`,
      })),
    };
  }

  async searchUsers(query: string): Promise<{ users: UserInfo[] }> {
    const state = this.store.getState();

    const matching = state.agents.filter((a) =>
      a.name.toLowerCase().includes(query.toLowerCase())
    );

    return {
      users: matching.map((a) => ({
        id: a.id,
        displayName: a.name,
      })),
    };
  }

  // ===== Stats =====

  async getStats(): Promise<SystemStats> {
    const state = this.store.getState();

    const totalVolume = state.predictionMarkets.reduce(
      (sum, m) => sum + m.totalVolume,
      0
    );

    return {
      totalAgents: state.agents.length,
      totalMarkets: state.predictionMarkets.length + state.perpMarkets.length,
      totalVolume,
    };
  }

  async getLeaderboard(limit = 10): Promise<{ entries: LeaderboardEntry[] }> {
    const state = this.store.getState();

    const sorted = [...state.agents].sort((a, b) => b.totalPnl - a.totalPnl);

    return {
      entries: sorted.slice(0, limit).map((a, i) => ({
        rank: i + 1,
        userId: a.id,
        displayName: a.name,
        pnl: a.totalPnl,
      })),
    };
  }

  // ===== Notifications =====

  async getNotifications(): Promise<{ notifications: Notification[] }> {
    return { notifications: [] };
  }

  // ===== Simulation Control =====

  tick(): SimulationTickResult {
    this.store.advanceTick();
    const progress = this.store.getProgress();
    return {
      tick: progress.tick,
      day: progress.day,
      hour: progress.hour,
    };
  }

  isComplete(): boolean {
    return this.store.isComplete();
  }

  getProgress(): {
    tick: number;
    day: number;
    hour: number;
    totalTicks: number;
  } {
    return this.store.getProgress();
  }

  getState() {
    return this.store.getState();
  }

  getGroundTruth(): Map<string, boolean> {
    return this.store.getGroundTruth();
  }

  // ===== Perp Trading =====

  async openPerpPosition(
    ticker: string,
    side: 'LONG' | 'SHORT',
    size: number,
    leverage: number
  ): Promise<{ positionId: string; entryPrice: number }> {
    const result = this.store.openPerpPosition(
      this.userId,
      ticker,
      side,
      size,
      leverage
    );

    if (!result.success) {
      throw new Error(result.error ?? 'Failed to open position');
    }

    return {
      positionId: result.positionId ?? '',
      entryPrice: result.price ?? 0,
    };
  }

  async closePerpPosition(positionId: string): Promise<{ pnl: number }> {
    const result = this.store.closePerpPosition(this.userId, positionId);

    if (!result.success) {
      throw new Error(result.error ?? 'Failed to close position');
    }

    return { pnl: result.totalCost ?? 0 };
  }
}

// Backwards compatibility alias
export { SimulationAdapter as OfflineGameAdapter };
