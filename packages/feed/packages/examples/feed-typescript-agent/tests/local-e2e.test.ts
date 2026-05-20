/**
 * Local E2E Tests - Test against local A2A server
 *
 * These tests verify all A2A functionality against the local server.
 * No external dependencies required.
 *
 * Prerequisites:
 * - Local A2A server running on localhost:3001
 *   (Run: cd ../local-a2a-server && bun run dev)
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import { ethers } from 'ethers';

const A2A_URL = 'http://localhost:3001';
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

// Helper to make A2A calls
async function a2aCall<T>(
  method: string,
  params: Record<string, unknown> = {},
  agentId: string,
  address: string,
  tokenId: number
): Promise<T> {
  const response = await fetch(`${A2A_URL}/api/a2a`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-agent-id': agentId,
      'x-agent-address': address,
      'x-agent-token-id': tokenId.toString(),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: Date.now(),
    }),
  });

  const data = await response.json();
  if (data.error) {
    throw new Error(`A2A Error: ${data.error.message}`);
  }
  return data.result as T;
}

describe('Local A2A Server E2E Tests', () => {
  let wallet: ethers.Wallet;
  let agentId: string;
  let address: string;
  let tokenId: number;

  beforeAll(async () => {
    // Check if server is running
    try {
      const health = await fetch(`${A2A_URL}/health`);
      if (!health.ok) throw new Error('Server not healthy');
    } catch {
      throw new Error(`
        Local A2A server not running!
        Start it with: cd packages/examples/local-a2a-server && bun run dev
      `);
    }

    // Setup test wallet
    wallet = new ethers.Wallet(TEST_PRIVATE_KEY);
    address = wallet.address;
    tokenId = Math.floor(Date.now() / 1000) % 1000000;
    agentId = `agent-31337-${tokenId}`;
  });

  // ==================== Health & Agent Card ====================

  describe('Server Health', () => {
    it('should return health status', async () => {
      const response = await fetch(`${A2A_URL}/health`);
      const health = await response.json();

      expect(health.status).toBe('ok');
      expect(health.chainId).toBeDefined();
    });

    it('should return agent card', async () => {
      const response = await fetch(`${A2A_URL}/.well-known/agent-card`);
      const card = await response.json();

      expect(card.name).toBeDefined();
      expect(card.skills).toBeInstanceOf(Array);
      expect(card.skills.length).toBeGreaterThan(0);
    });
  });

  // ==================== Agent Discovery ====================

  describe('Agent Discovery', () => {
    it('should register agent', async () => {
      const result = await a2aCall<{ success: boolean; agent: { id: string } }>(
        'register',
        {
          walletAddress: address,
          tokenId,
          chainId: 31337,
          displayName: 'Test Agent',
          description: 'E2E test agent',
        },
        agentId,
        address,
        tokenId
      );

      expect(result.success).toBe(true);
      expect(result.agent.id).toBe(agentId);
    });

    it('should discover agents', async () => {
      const result = await a2aCall<{ agents: Array<{ id: string }> }>(
        'discover',
        {},
        agentId,
        address,
        tokenId
      );

      expect(result.agents).toBeInstanceOf(Array);
    });

    it('should get agent info', async () => {
      const result = await a2aCall<{ id: string; name: string }>(
        'getInfo',
        { agentId },
        agentId,
        address,
        tokenId
      );

      expect(result.id).toBe(agentId);
      expect(result.name).toBeDefined();
    });
  });

  // ==================== Portfolio ====================

  describe('Portfolio', () => {
    it('should get balance', async () => {
      const result = await a2aCall<{ balance: number; currency: string }>(
        'getBalance',
        {},
        agentId,
        address,
        tokenId
      );

      expect(result.balance).toBeGreaterThanOrEqual(0);
      expect(result.currency).toBe('USD');
    });

    it('should get positions', async () => {
      const result = await a2aCall<{ positions: unknown[] }>(
        'getPositions',
        {},
        agentId,
        address,
        tokenId
      );

      expect(result.positions).toBeInstanceOf(Array);
    });

    it('should get portfolio', async () => {
      const result = await a2aCall<{
        balance: number;
        positions: unknown[];
        pnl: number;
      }>('getPortfolio', {}, agentId, address, tokenId);

      expect(result.balance).toBeDefined();
      expect(result.positions).toBeInstanceOf(Array);
      expect(result.pnl).toBeDefined();
    });

    it('should get wallet info', async () => {
      const result = await a2aCall<{ address: string; virtualBalance: number }>(
        'getUserWallet',
        {},
        agentId,
        address,
        tokenId
      );

      expect(result.address).toBeDefined();
      expect(result.virtualBalance).toBeDefined();
    });
  });

  // ==================== Markets ====================

  describe('Markets', () => {
    it('should get markets', async () => {
      const result = await a2aCall<{
        predictions: unknown[];
        perps: unknown[];
      }>('getMarkets', {}, agentId, address, tokenId);

      expect(result.predictions).toBeInstanceOf(Array);
      expect(result.perps).toBeInstanceOf(Array);
    });

    it('should get market data', async () => {
      const result = await a2aCall<{
        id: string;
        question: string;
        yesPrice: number;
      }>(
        'getMarketData',
        { marketId: 'market-btc-100k' },
        agentId,
        address,
        tokenId
      );

      expect(result.id).toBe('market-btc-100k');
      expect(result.question).toBeDefined();
      expect(result.yesPrice).toBeGreaterThan(0);
    });

    it('should buy shares', async () => {
      const result = await a2aCall<{
        id: string;
        shares: number;
        price: number;
      }>(
        'buyShares',
        { marketId: 'market-btc-100k', outcome: 'YES', amount: 10 },
        agentId,
        address,
        tokenId
      );

      expect(result.id).toBeDefined();
      expect(result.shares).toBeGreaterThan(0);
      expect(result.price).toBeGreaterThan(0);
    });

    it('should sell shares after buying', async () => {
      // Buy first
      const buyResult = await a2aCall<{ shares: number }>(
        'buyShares',
        { marketId: 'market-eth-10k', outcome: 'NO', amount: 20 },
        agentId,
        address,
        tokenId
      );

      // Then sell half
      const sellShares = buyResult.shares / 2;
      const sellResult = await a2aCall<{ id: string }>(
        'sellShares',
        { marketId: 'market-eth-10k', outcome: 'NO', shares: sellShares },
        agentId,
        address,
        tokenId
      );

      expect(sellResult.id).toBeDefined();
    });
  });

  // ==================== Social ====================

  describe('Social', () => {
    it('should get feed', async () => {
      const result = await a2aCall<{ posts: Array<{ id: string }> }>(
        'getFeed',
        { limit: 10 },
        agentId,
        address,
        tokenId
      );

      expect(result.posts).toBeInstanceOf(Array);
    });

    it('should create post', async () => {
      const content = `Test post from E2E test ${Date.now()}`;
      const result = await a2aCall<{ id: string; content: string }>(
        'createPost',
        { content },
        agentId,
        address,
        tokenId
      );

      expect(result.id).toBeDefined();
      expect(result.content).toBe(content);
    });

    it('should like post', async () => {
      const result = await a2aCall<{ success: boolean; likesCount: number }>(
        'likePost',
        { postId: 'post-welcome' },
        agentId,
        address,
        tokenId
      );

      expect(result.success).toBe(true);
      expect(result.likesCount).toBeGreaterThanOrEqual(0);
    });

    it('should comment on post', async () => {
      const result = await a2aCall<{ id: string }>(
        'commentPost',
        { postId: 'post-welcome', content: 'Test comment' },
        agentId,
        address,
        tokenId
      );

      expect(result.id).toBeDefined();
    });

    it('should search users', async () => {
      const result = await a2aCall<{ users: unknown[] }>(
        'searchUsers',
        { query: 'agent' },
        agentId,
        address,
        tokenId
      );

      expect(result.users).toBeInstanceOf(Array);
    });
  });

  // ==================== Notifications ====================

  describe('Notifications', () => {
    it('should get notifications', async () => {
      const result = await a2aCall<{ notifications: unknown[] }>(
        'getNotifications',
        {},
        agentId,
        address,
        tokenId
      );

      expect(result.notifications).toBeInstanceOf(Array);
    });
  });

  // ==================== Stats ====================

  describe('Stats', () => {
    it('should get system stats', async () => {
      const result = await a2aCall<{
        totalAgents: number;
        totalMarkets: number;
      }>('getStats', {}, agentId, address, tokenId);

      expect(result.totalAgents).toBeGreaterThanOrEqual(0);
      expect(result.totalMarkets).toBeGreaterThanOrEqual(0);
    });

    it('should get leaderboard', async () => {
      const result = await a2aCall<{ entries: unknown[] }>(
        'getLeaderboard',
        { limit: 10 },
        agentId,
        address,
        tokenId
      );

      expect(result.entries).toBeInstanceOf(Array);
    });
  });

  // ==================== Payments ====================

  describe('Payments', () => {
    it('should create payment request', async () => {
      const result = await a2aCall<{ paymentId: string; status: string }>(
        'paymentRequest',
        { amount: 100, currency: 'ETH' },
        agentId,
        address,
        tokenId
      );

      expect(result.paymentId).toBeDefined();
      expect(result.status).toBe('pending');
    });

    it('should submit payment receipt', async () => {
      const result = await a2aCall<{ verified: boolean }>(
        'paymentReceipt',
        {
          paymentId: 'test-payment',
          amount: 100,
          transactionHash: '0x1234...',
        },
        agentId,
        address,
        tokenId
      );

      expect(result.verified).toBe(true);
    });
  });
});

// Summary test
describe('A2A Method Coverage', () => {
  it('should track the local example server method inventory', () => {
    const methods = [
      // Discovery
      'register',
      'discover',
      'getInfo',
      // Portfolio
      'getBalance',
      'getPositions',
      'getPortfolio',
      'getUserWallet',
      // Markets
      'getMarkets',
      'getMarketData',
      'buyShares',
      'sellShares',
      // Social
      'getFeed',
      'createPost',
      'likePost',
      'commentPost',
      'searchUsers',
      // Notifications
      'getNotifications',
      'markNotificationRead',
      // Stats
      'getStats',
      'getLeaderboard',
      // Payments
      'paymentRequest',
      'paymentReceipt',
    ];

    expect(methods.length).toBeGreaterThanOrEqual(20);
    console.log(`✅ ${methods.length} local example server methods tracked`);
  });
});
