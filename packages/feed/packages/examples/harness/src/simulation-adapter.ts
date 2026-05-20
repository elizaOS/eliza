/**
 * Simulation A2A Adapter
 *
 * Bridges the harness A2AClientInterface with the training package's
 * SimulationA2AInterface for offline/in-memory A2A operations.
 *
 * This enables running agents through the simulation without any server!
 *
 * @example
 * ```typescript
 * import { SimulationEngine } from '@babylon/training/benchmark';
 * import { SimulationA2AAdapter } from './simulation-adapter';
 *
 * const engine = new SimulationEngine(config);
 * const adapter = new SimulationA2AAdapter(engine, 'agent-123');
 *
 * // Now use adapter wherever A2AClientInterface is expected
 * const markets = await adapter.getMarkets();
 * ```
 */

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

/**
 * Minimal interface for SimulationEngine compatibility
 * This matches the core methods from packages/training/src/benchmark/SimulationEngine.ts
 */
export interface SimulationEngineInterface {
  getGameState(): GameState;
  performAction(
    type: string,
    data: Record<string, unknown>
  ): Promise<{ success: boolean; result?: unknown; error?: string }>;
  advanceTick(): void;
  isComplete(): boolean;
  getCurrentTickNumber(): number;
  getTotalTicks(): number;
}

/**
 * Game state structure from simulation
 */
export interface GameState {
  tick: number;
  timestamp: number;
  predictionMarkets: SimulationMarket[];
  perpetualMarkets: PerpetualMarket[];
  agents: SimulatedAgent[];
  posts?: SimulationPost[];
  groupChats?: unknown[];
}

interface SimulationMarket {
  id: string;
  question: string;
  yesShares: number;
  noShares: number;
  yesPrice: number;
  noPrice: number;
  totalVolume: number;
  liquidity: number;
  resolved: boolean;
  createdAt: number;
  resolveAt: number;
}

interface PerpetualMarket {
  ticker: string;
  price: number;
  priceChange24h?: number;
  volume24h: number;
  openInterest: number;
  fundingRate: number;
  nextFundingTime?: number;
}

interface SimulatedAgent {
  id: string;
  name: string;
  reputation: number;
  totalPnl: number;
}

interface SimulationPost {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: number;
  likes: number;
  comments: number;
  marketId?: string;
}

/**
 * Adapter that implements A2AClientInterface using SimulationEngine
 *
 * This is the bridge that enables "offline A2A" - running agents
 * through simulation without any HTTP server.
 */
export class SimulationA2AAdapter implements A2AClientInterface {
  private engine: SimulationEngineInterface;
  private agentId: string;
  private balance = 10000;
  private positions: Map<string, Position> = new Map();
  private nextPositionId = 1;
  private posts: SimulationPost[] = [];

  constructor(engine: SimulationEngineInterface, agentId: string) {
    this.engine = engine;
    this.agentId = agentId;
  }

  getAgentId(): string {
    return this.agentId;
  }

  // ===== Portfolio =====

  async getBalance(): Promise<{ balance: number; currency: string }> {
    return { balance: this.balance, currency: 'USD' };
  }

  async getPositions(): Promise<{ positions: Position[] }> {
    const state = this.engine.getGameState();
    const positions: Position[] = [];

    for (const [, pos] of this.positions) {
      const market = state.predictionMarkets.find((m) => m.id === pos.marketId);
      if (market) {
        const currentPrice =
          pos.outcome === 'YES' ? market.yesPrice : market.noPrice;
        positions.push({
          ...pos,
          currentPrice,
          pnl: (currentPrice - pos.avgPrice) * pos.shares,
        });
      }
    }

    return { positions };
  }

  async getPortfolio(): Promise<{
    balance: number;
    positions: Position[];
    pnl: number;
  }> {
    const { positions } = await this.getPositions();
    const pnl = positions.reduce((sum, p) => sum + (p.pnl || 0), 0);
    return { balance: this.balance, positions, pnl };
  }

  // ===== Markets =====

  async getMarkets(): Promise<{ predictions: Market[]; perps: Market[] }> {
    const state = this.engine.getGameState();

    const predictions: Market[] = state.predictionMarkets
      .filter((m) => !m.resolved)
      .map((m) => ({
        id: m.id,
        question: m.question,
        yesPrice: m.yesPrice,
        noPrice: m.noPrice,
        status: 'active',
      }));

    const perps: Market[] = state.perpetualMarkets.map((m) => ({
      id: m.ticker,
      question: m.ticker,
      yesPrice: m.price,
      noPrice: 0,
      status: 'active',
    }));

    return { predictions, perps };
  }

  async getMarketData(marketId: string): Promise<Market> {
    const state = this.engine.getGameState();
    const market = state.predictionMarkets.find((m) => m.id === marketId);

    if (!market) {
      throw new Error(`Market ${marketId} not found`);
    }

    return {
      id: market.id,
      question: market.question,
      yesPrice: market.yesPrice,
      noPrice: market.noPrice,
      status: market.resolved ? 'resolved' : 'active',
    };
  }

  async buyShares(
    marketId: string,
    outcome: 'YES' | 'NO',
    amount: number
  ): Promise<Trade> {
    const result = await this.engine.performAction('buy_prediction', {
      marketId,
      outcome,
      amount,
    });

    if (!result.success) {
      throw new Error(result.error || 'Failed to buy shares');
    }

    const { positionId, shares } = result.result as {
      positionId: string;
      shares: number;
    };
    const state = this.engine.getGameState();
    const market = state.predictionMarkets.find((m) => m.id === marketId);
    const price = market
      ? outcome === 'YES'
        ? market.yesPrice
        : market.noPrice
      : 0.5;

    // Track position
    const existingPos = Array.from(this.positions.values()).find(
      (p) => p.marketId === marketId && p.outcome === outcome
    );

    if (existingPos) {
      const totalShares = existingPos.shares + shares;
      const avgPrice =
        (existingPos.avgPrice * existingPos.shares + price * shares) /
        totalShares;
      existingPos.shares = totalShares;
      existingPos.avgPrice = avgPrice;
    } else {
      const newPos: Position = {
        id: positionId || `pos-${this.nextPositionId++}`,
        marketId,
        outcome,
        shares,
        avgPrice: price,
      };
      this.positions.set(newPos.id, newPos);
    }

    this.balance -= amount;

    return {
      id: `trade-${Date.now()}`,
      marketId,
      outcome,
      shares,
      price,
      totalCost: amount,
    };
  }

  async sellShares(
    marketId: string,
    outcome: 'YES' | 'NO',
    sharesToSell: number
  ): Promise<Trade> {
    const state = this.engine.getGameState();
    const market = state.predictionMarkets.find((m) => m.id === marketId);

    if (!market) {
      throw new Error(`Market ${marketId} not found`);
    }

    const price = outcome === 'YES' ? market.yesPrice : market.noPrice;
    const proceeds = sharesToSell * price;

    // Update position
    const pos = Array.from(this.positions.values()).find(
      (p) => p.marketId === marketId && p.outcome === outcome
    );

    if (pos) {
      pos.shares -= sharesToSell;
      if (pos.shares <= 0) {
        this.positions.delete(pos.id);
      }
    }

    this.balance += proceeds;

    return {
      id: `trade-${Date.now()}`,
      marketId,
      outcome,
      shares: sharesToSell,
      price,
      totalCost: proceeds,
    };
  }

  // ===== Social =====

  async getFeed(limit = 20): Promise<{ posts: Post[] }> {
    const state = this.engine.getGameState();
    const allPosts = [...(state.posts || []), ...this.posts]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);

    return {
      posts: allPosts.map((p) => ({
        id: p.id,
        content: p.content,
        authorId: p.authorId,
        authorName: p.authorName,
        likesCount: p.likes,
        createdAt: new Date(p.createdAt).toISOString(),
      })),
    };
  }

  async createPost(content: string): Promise<Post> {
    const result = await this.engine.performAction('create_post', { content });

    if (!result.success) {
      throw new Error(result.error || 'Failed to create post');
    }

    const { postId } = result.result as { postId: string };

    const newPost: SimulationPost = {
      id: postId,
      authorId: this.agentId,
      authorName: `Agent ${this.agentId.slice(-6)}`,
      content,
      createdAt: Date.now(),
      likes: 0,
      comments: 0,
    };

    this.posts.push(newPost);

    return {
      id: postId,
      content,
      authorId: this.agentId,
      authorName: newPost.authorName,
      likesCount: 0,
      createdAt: new Date().toISOString(),
    };
  }

  async likePost(
    postId: string
  ): Promise<{ success: boolean; likesCount: number }> {
    // Simulation - just increment likes locally
    const post = this.posts.find((p) => p.id === postId);
    if (post) {
      post.likes++;
      return { success: true, likesCount: post.likes };
    }
    return { success: true, likesCount: 1 };
  }

  async commentPost(postId: string, content: string): Promise<{ id: string }> {
    // Simulation - just create a comment ID
    return { id: `comment-${Date.now()}-${postId.slice(-4)}` };
  }

  // ===== Discovery =====

  async discover(): Promise<{ agents: AgentInfo[] }> {
    const state = this.engine.getGameState();
    return {
      agents: state.agents.map((a) => ({
        id: a.id,
        name: a.name,
        walletAddress: `0x${a.id.slice(-40).padStart(40, '0')}`,
      })),
    };
  }

  async searchUsers(query: string): Promise<{ users: UserInfo[] }> {
    const state = this.engine.getGameState();
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
    const state = this.engine.getGameState();
    const totalVolume = state.predictionMarkets.reduce(
      (sum, m) => sum + m.totalVolume,
      0
    );

    return {
      totalAgents: state.agents.length,
      totalMarkets:
        state.predictionMarkets.length + state.perpetualMarkets.length,
      totalVolume,
    };
  }

  async getLeaderboard(limit = 10): Promise<{ entries: LeaderboardEntry[] }> {
    const state = this.engine.getGameState();
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
    // Simulation doesn't generate notifications
    return { notifications: [] };
  }

  // ===== Simulation Control =====

  /**
   * Advance simulation by one tick
   * Call this between agent decisions to progress time
   */
  advanceTick(): void {
    this.engine.advanceTick();
  }

  /**
   * Check if simulation is complete
   */
  isComplete(): boolean {
    return this.engine.isComplete();
  }

  /**
   * Get current simulation progress
   */
  getProgress(): { current: number; total: number } {
    return {
      current: this.engine.getCurrentTickNumber(),
      total: this.engine.getTotalTicks(),
    };
  }
}
