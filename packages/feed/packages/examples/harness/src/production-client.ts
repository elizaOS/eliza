/**
 * Babylon Production A2A Client
 *
 * Implements the harness A2AClientInterface against the real Babylon server
 * using the official A2A protocol (message/send with operation + params).
 *
 * Use this client to run harness agents against:
 *   - Local dev: http://localhost:3000
 *   - Production: https://babylon.market
 *
 * @example
 * ```typescript
 * import { BabylonProductionClient } from '@babylon/agent-harness';
 *
 * const client = new BabylonProductionClient({
 *   baseUrl: 'http://localhost:3000',
 *   apiKey: process.env.BABYLON_API_KEY!,
 * });
 *
 * const result = await runHarness({
 *   a2aUrl: 'http://localhost:3000',
 *   agents: [createLLMAgent()],
 *   archetypes: [getArchetype('trader')],
 *   clientFactory: () => client,
 *   // ... other config
 * });
 * ```
 */

import type { A2AClient as A2AClientType, Message, Task } from '@a2a-js/sdk';
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

export interface BabylonProductionClientConfig {
  /** Base URL of the Babylon server (e.g. http://localhost:3000) */
  baseUrl: string;
  /** Babylon-issued API key for authentication */
  apiKey: string;
  /** Optional agent display name (used for context ID) */
  agentName?: string;
}

/**
 * Maps harness A2AClientInterface onto the official Babylon A2A protocol.
 * All operations use message/send with { operation, params } DataParts.
 */
export class BabylonProductionClient implements A2AClientInterface {
  private config: BabylonProductionClientConfig;
  private clientInstance: A2AClientType | null = null;
  private contextId: string;
  private msgId = 1;

  constructor(config: BabylonProductionClientConfig) {
    this.config = config;
    this.contextId = `harness-${config.agentName ?? 'agent'}-${Date.now()}`;
  }

  // ─── Internal A2A plumbing ────────────────────────────────────────────────

  private async getClient(): Promise<A2AClientType> {
    if (this.clientInstance) return this.clientInstance;

    // Dynamic import keeps the SDK optional if you only use HarnessA2AClient
    const { A2AClient } = await import('@a2a-js/sdk');
    const cardUrl = `${this.config.baseUrl}/.well-known/agent-card`;
    const apiKey = this.config.apiKey;

    this.clientInstance = await A2AClient.fromCardUrl(cardUrl, {
      fetchImpl: (url: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set('x-babylon-api-key', apiKey);
        return fetch(url as RequestInfo, { ...(init ?? {}), headers });
      },
    } as Parameters<typeof A2AClient.fromCardUrl>[1]);

    return this.clientInstance;
  }

  private async op<T>(
    operation: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    const client = await this.getClient();

    const message: Message = {
      kind: 'message',
      messageId: `h-${Date.now()}-${this.msgId++}`,
      role: 'user',
      contextId: this.contextId,
      parts: [
        { kind: 'text', text: operation },
        { kind: 'data', data: { operation, params } },
      ],
    };

    const response = (await client.sendMessage({ message })) as Task | Message;

    // Extract result data from artifacts or message parts
    const artifacts = (response as Task).artifacts ?? [];
    for (const artifact of artifacts) {
      for (const part of artifact.parts ?? []) {
        if (part.kind === 'data') {
          return (part as { kind: 'data'; data: T }).data;
        }
      }
    }

    // Fallback: check message parts
    const parts = (response as Message).parts ?? [];
    for (const part of parts) {
      if (part.kind === 'data') {
        return (part as { kind: 'data'; data: T }).data;
      }
    }

    // Return empty result rather than throwing — some operations return no data
    return {} as T;
  }

  // ─── A2AClientInterface implementation ────────────────────────────────────

  async getBalance(): Promise<{ balance: number; currency: string }> {
    return this.op<{ balance: number; currency: string }>(
      'portfolio.get_balance'
    );
  }

  async getPositions(): Promise<{ positions: Position[] }> {
    return this.op<{ positions: Position[] }>('portfolio.get_positions');
  }

  async getPortfolio(): Promise<{
    balance: number;
    positions: Position[];
    pnl: number;
  }> {
    return this.op<{ balance: number; positions: Position[]; pnl: number }>(
      'portfolio.get_portfolio'
    );
  }

  async getMarkets(): Promise<{ predictions: Market[]; perps: Market[] }> {
    return this.op<{ predictions: Market[]; perps: Market[] }>(
      'markets.list_prediction'
    );
  }

  async getMarketData(marketId: string): Promise<Market> {
    return this.op<Market>('markets.get_market', { marketId });
  }

  async buyShares(
    marketId: string,
    outcome: 'YES' | 'NO',
    amount: number
  ): Promise<Trade> {
    return this.op<Trade>('markets.buy_shares', { marketId, outcome, amount });
  }

  async sellShares(
    marketId: string,
    outcome: 'YES' | 'NO',
    shares: number
  ): Promise<Trade> {
    return this.op<Trade>('markets.sell_shares', { marketId, outcome, shares });
  }

  async getFeed(limit = 20): Promise<{ posts: Post[] }> {
    return this.op<{ posts: Post[] }>('social.get_feed', { limit });
  }

  async createPost(content: string): Promise<Post> {
    return this.op<Post>('social.create_post', { content });
  }

  async likePost(
    postId: string
  ): Promise<{ success: boolean; likesCount: number }> {
    return this.op<{ success: boolean; likesCount: number }>(
      'social.like_post',
      { postId }
    );
  }

  async commentPost(postId: string, content: string): Promise<{ id: string }> {
    return this.op<{ id: string }>('social.comment_post', { postId, content });
  }

  async discover(): Promise<{ agents: AgentInfo[] }> {
    return this.op<{ agents: AgentInfo[] }>('users.discover_agents');
  }

  async searchUsers(query: string): Promise<{ users: UserInfo[] }> {
    return this.op<{ users: UserInfo[] }>('users.search', { query });
  }

  async getStats(): Promise<SystemStats> {
    return this.op<SystemStats>('stats.system');
  }

  async getLeaderboard(limit = 10): Promise<{ entries: LeaderboardEntry[] }> {
    return this.op<{ entries: LeaderboardEntry[] }>('stats.leaderboard', {
      limit,
    });
  }

  async getNotifications(): Promise<{ notifications: Notification[] }> {
    return this.op<{ notifications: Notification[] }>('notifications.list');
  }
}
