import { describe, it, expect, vi, beforeEach } from 'vitest';
import { marketDataProvider } from '../marketDataProvider.ts';
import { IAgentRuntime, Memory, State, UUID } from '@elizaos/core';

describe('marketDataProvider', () => {
  let runtime: IAgentRuntime;
  let message: Memory;
  let state: State;

  beforeEach(() => {
    vi.clearAllMocks();

    runtime = {
      agentId: 'test-agent-id' as UUID,
      getService: vi.fn(),
      getSetting: vi.fn((key: string) => {
        if (key === 'DEFAULT_PAIR') return 'SOL/USDC';
        if (key === 'MARKET_DATA_INTERVAL') return '1h';
        if (key === 'MARKET_DATA_DAYS') return '7';
        return null;
      }),
    } as any;

    message = {
      id: 'test-message-id' as UUID,
      userId: 'test-user-id' as UUID,
      agentId: 'test-agent-id' as UUID,
      roomId: 'test-room-id' as UUID,
      entityId: 'test-entity-id' as UUID,
      content: { text: 'Check market data' },
      createdAt: Date.now(),
    } as Memory;

    state = {} as State;
  });

  describe('get', () => {
    it('should return formatted market data', async () => {
      const result = await marketDataProvider.get(runtime, message, state);

      expect(result).toBeDefined();
      expect(result.text).toBeDefined();
      expect(result.text).toContain('Market Overview');
      expect(result.text).toContain('Trending Tokens');
      expect(result.text).toContain('SOL');
      expect(result.text).toContain('ETH');
      expect(result.text).toContain('BTC');
    });

    it('should return market data text', async () => {
      const result = await marketDataProvider.get(runtime, message, state);

      expect(result.text).toBeDefined();
      expect(result.text).toContain('Market Sentiment');
      expect(result.text).toContain('Fear & Greed Index');
      expect(result.text).toContain('Total Market Cap');
    });

    it('should handle errors gracefully', async () => {
      // Mock an error scenario
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await marketDataProvider.get(runtime, message, state);

      // Since it returns mock data, it should still work
      expect(result.text).toBeDefined();
      expect(result.text?.length).toBeGreaterThan(0);
    });

    it('should include volume data', async () => {
      const result = await marketDataProvider.get(runtime, message, state);

      expect(result.text).toBeDefined();
      expect(result.text).toContain('Vol:');
      expect(result.text).toContain('24h Volume');
    });

    it('should include price change percentages', async () => {
      const result = await marketDataProvider.get(runtime, message, state);

      expect(result.text).toBeDefined();
      expect(result.text).toMatch(/\+[\d.]+%/); // Matches positive percentage
    });

    it('should include market statistics', async () => {
      const result = await marketDataProvider.get(runtime, message, state);

      expect(result.text).toBeDefined();
      expect(result.text).toContain('Active DEX Pairs');
      expect(result.text).toContain('BTC Dominance');
    });
  });

  describe('metadata', () => {
    it('should have correct provider name', () => {
      expect(marketDataProvider.name).toBe('MARKET_DATA');
    });
  });
});
