import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import { getClobMarkets } from '../src/actions/getClobMarkets';
import { initializeClobClient } from '../src/utils/clobClient';
import { callLLMWithTimeout } from '../src/utils/llmHelpers';

// Mock the dependencies
vi.mock('../src/utils/clobClient');
vi.mock('../src/utils/llmHelpers');

const mockInitializeClobClient = vi.mocked(initializeClobClient);
const mockCallLLMWithTimeout = vi.mocked(callLLMWithTimeout);

describe('getClobMarkets Action', () => {
  let mockRuntime: IAgentRuntime;
  let mockMessage: Memory;
  let mockState: State;
  let mockCallback: vi.Mock;
  let mockClobClient: any;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Mock runtime
    mockRuntime = {
      getSetting: vi.fn().mockReturnValue('https://clob.polymarket.com'),
    } as any;

    // Mock message
    mockMessage = {
      id: 'a1b2c3d4-e5f6-4a7b-8c9d-1e2f3a4b5c6d' as `${string}-${string}-${string}-${string}-${string}`,
      userId: 'test-user-id',
      content: { text: 'Get CLOB markets' },
      roomId:
        'b2c3d4e5-f6a7-4b8c-9d1e-2f3a4b5c6d7e' as `${string}-${string}-${string}-${string}-${string}`,
      entityId:
        'c3d4e5f6-a7b8-4c9d-1e2f-3a4b5c6d7e8f' as `${string}-${string}-${string}-${string}-${string}`,
    } as Memory;

    // Mock state
    mockState = {} as State;

    // Mock callback
    mockCallback = vi.fn();

    // Mock CLOB client
    mockClobClient = {
      getMarkets: vi.fn(),
    };

    mockInitializeClobClient.mockResolvedValue(mockClobClient);
  });

  describe('Action Properties', () => {
    it('should have correct action properties', () => {
      expect(getClobMarkets.name).toBe('GET_CLOB_MARKETS');
      expect(getClobMarkets.description).toContain('CLOB');
      expect(getClobMarkets.description).toContain('trading');
      expect(getClobMarkets.similes).toContain('CLOB_MARKETS');
      expect(getClobMarkets.similes).toContain('TRADING_MARKETS');
      expect(getClobMarkets.similes).toContain('TRADEABLE_MARKETS');
    });

    it('should have comprehensive trigger words', () => {
      const expectedTriggers = [
        'CLOB_MARKETS',
        'GET_CLOB_MARKETS',
        'TRADING_MARKETS',
        'TRADEABLE_MARKETS',
        'MARKETS_FOR_TRADING',
        'CLOB_ENABLED',
        'TRADING_ENABLED',
        'ACTIVE_TRADING',
        'CLOB_TRADING',
        'ORDER_BOOK_MARKETS',
        'AVAILABLE_FOR_TRADING',
        'GET_TRADING_MARKETS',
        'SHOW_CLOB_MARKETS',
        'LIST_CLOB_MARKETS',
        'FETCH_CLOB_MARKETS',
        'CLOB_AVAILABLE',
        'TRADING_AVAILABLE',
        'ORDERBOOK_MARKETS',
      ];

      for (const trigger of expectedTriggers) {
        expect(getClobMarkets.similes).toContain(trigger);
      }
    });

    it('should have examples with correct format', () => {
      expect(getClobMarkets.examples).toBeDefined();
      expect(Array.isArray(getClobMarkets.examples || [])).toBe(true);
      expect((getClobMarkets.examples || []).length).toBeGreaterThan(0);
    });
  });

  describe('Validation', () => {
    it('should always validate as true', async () => {
      const result = await getClobMarkets.validate(mockRuntime, mockMessage);
      expect(result).toBe(true);
    });
  });

  describe('Successful Execution', () => {
    it('should successfully retrieve CLOB markets', async () => {
      const mockMarketsResponse = {
        data: [
          {
            condition_id: 'test-condition-1',
            question: 'Will Donald Trump win the 2024 election?',
            category: 'Politics',
            active: true,
            tokens: [
              { token_id: 'token-1', outcome: 'Yes' },
              { token_id: 'token-2', outcome: 'No' },
            ],
            minimum_order_size: '0.01',
            minimum_tick_size: '0.01',
          },
          {
            condition_id: 'test-condition-2',
            question: 'Will Bitcoin reach $100k by end of 2024?',
            category: 'Crypto',
            active: true,
            tokens: [
              { token_id: 'token-3', outcome: 'Yes' },
              { token_id: 'token-4', outcome: 'No' },
            ],
            minimum_order_size: '0.01',
            minimum_tick_size: '0.01',
          },
        ],
        count: 2,
        next_cursor: 'ABC123',
      };

      mockClobClient.getMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({});

      const result = await getClobMarkets.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(true);
      expect(mockClobClient.getMarkets).toHaveBeenCalledWith('', {
        category: undefined,
        active: undefined,
        limit: undefined,
      });
      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('CLOB Markets (Trading Available)'),
        content: {
          action: 'clob_markets_retrieved',
          markets: mockMarketsResponse.data,
          count: 2,
          next_cursor: 'ABC123',
          filters: {},
          timestamp: expect.any(String),
        },
      });
    });

    it('should handle filters from LLM extraction', async () => {
      const mockMarketsResponse = {
        data: [
          {
            condition_id: 'test-condition-1',
            question: 'Will Trump win?',
            category: 'Politics',
            active: true,
            tokens: [],
            minimum_order_size: '0.01',
            minimum_tick_size: '0.01',
          },
        ],
        count: 1,
        next_cursor: 'LTE=',
      };

      mockClobClient.getMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({
        category: 'politics',
        active: true,
        limit: 10,
      });

      const result = await getClobMarkets.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(true);
      expect(mockClobClient.getMarkets).toHaveBeenCalledWith('', {
        category: 'politics',
        active: true,
        limit: 10,
      });
      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('category=politics'),
        content: expect.objectContaining({
          action: 'clob_markets_retrieved',
          filters: {
            category: 'politics',
            active: true,
            limit: 10,
          },
        }),
      });
    });

    it('should handle empty markets response', async () => {
      const mockMarketsResponse = {
        data: [],
        count: 0,
        next_cursor: 'LTE=',
      };

      mockClobClient.getMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({});

      const result = await getClobMarkets.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(true);
      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('No CLOB markets found'),
        content: expect.objectContaining({
          action: 'clob_markets_retrieved',
          markets: [],
          count: 0,
        }),
      });
    });

    it('should handle markets with minimal data', async () => {
      const mockMarketsResponse = {
        data: [
          {
            condition_id: 'minimal-market',
            question: null,
            category: null,
            active: false,
            tokens: [],
            minimum_order_size: null,
            minimum_tick_size: null,
          },
        ],
        count: 1,
        next_cursor: null,
      };

      mockClobClient.getMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({});

      const result = await getClobMarkets.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(true);
      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('Unknown Market'),
        content: expect.objectContaining({
          action: 'clob_markets_retrieved',
        }),
      });
    });
  });

  describe('LLM Parameter Extraction', () => {
    it('should use LLM extracted parameters', async () => {
      const mockMarketsResponse = {
        data: [],
        count: 0,
        next_cursor: 'LTE=',
      };

      mockClobClient.getMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({
        category: 'crypto',
        active: true,
      });

      await getClobMarkets.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallLLMWithTimeout).toHaveBeenCalledWith(
        mockRuntime,
        mockState,
        expect.stringContaining('filter parameters'),
        'getClobMarkets',
        30000
      );
      expect(mockClobClient.getMarkets).toHaveBeenCalledWith('', {
        category: 'crypto',
        active: true,
        limit: undefined,
      });
    });

    it('should handle LLM extraction failure gracefully', async () => {
      const mockMarketsResponse = {
        data: [],
        count: 0,
        next_cursor: 'LTE=',
      };

      mockClobClient.getMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockRejectedValue(new Error('LLM timeout'));

      const result = await getClobMarkets.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(true);
      expect(mockClobClient.getMarkets).toHaveBeenCalledWith('', {
        category: undefined,
        active: undefined,
        limit: undefined,
      });
    });

    it('should handle LLM error response', async () => {
      const mockMarketsResponse = {
        data: [],
        count: 0,
        next_cursor: 'LTE=',
      };

      mockClobClient.getMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({ error: 'No filters found' });

      const result = await getClobMarkets.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(true);
      expect(mockClobClient.getMarkets).toHaveBeenCalledWith('', {
        category: undefined,
        active: undefined,
        limit: undefined,
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle CLOB client initialization failure', async () => {
      mockInitializeClobClient.mockRejectedValue(new Error('Client init failed'));

      const result = await getClobMarkets.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(false);
      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('Error getting CLOB markets'),
        content: {
          action: 'clob_markets_error',
          error: 'Client init failed',
          timestamp: expect.any(String),
        },
      });
    });

    it('should handle API call failure', async () => {
      mockClobClient.getMarkets.mockRejectedValue(new Error('API error'));
      mockCallLLMWithTimeout.mockResolvedValue({});

      const result = await getClobMarkets.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(false);
      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('Error getting CLOB markets'),
        content: {
          action: 'clob_markets_error',
          error: 'API error',
          timestamp: expect.any(String),
        },
      });
    });

    it('should handle unknown error types', async () => {
      mockClobClient.getMarkets.mockRejectedValue('String error');
      mockCallLLMWithTimeout.mockResolvedValue({});

      const result = await getClobMarkets.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(false);
      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('Unknown error'),
        content: {
          action: 'clob_markets_error',
          error: 'Unknown error',
          timestamp: expect.any(String),
        },
      });
    });

    it('should handle missing callback gracefully', async () => {
      const mockMarketsResponse = {
        data: [],
        count: 0,
        next_cursor: 'LTE=',
      };

      mockClobClient.getMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({});

      const result = await getClobMarkets.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {}
        // No callback provided
      );

      expect(result).toBe(true);
      expect(mockCallback).not.toHaveBeenCalled();
    });
  });

  describe('Response Formatting', () => {
    it('should format response with trading information', async () => {
      const mockMarketsResponse = {
        data: [
          {
            condition_id: 'test-condition-1',
            question: 'Test Trading Market',
            category: 'Test',
            active: true,
            tokens: [
              { token_id: 'token-1', outcome: 'Yes' },
              { token_id: 'token-2', outcome: 'No' },
            ],
            minimum_order_size: '0.05',
            minimum_tick_size: '0.02',
          },
        ],
        count: 1,
        next_cursor: 'ABC123',
      };

      mockClobClient.getMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({});

      await getClobMarkets.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      const callArgs = mockCallback.mock.calls[0][0];
      expect(callArgs.text).toContain('Test Trading Market');
      expect(callArgs.text).toContain('Category: Test');
      expect(callArgs.text).toContain('Min Order: $0.05');
      expect(callArgs.text).toContain('Min Tick: $0.02');
      expect(callArgs.text).toContain('Trading: ✅ Active');
    });

    it('should handle large number of markets by truncating display', async () => {
      const markets = Array.from({ length: 10 }, (_, i) => ({
        condition_id: `condition-${i}`,
        question: `Trading Market ${i}`,
        category: 'Test',
        active: true,
        tokens: [],
        minimum_order_size: '0.01',
        minimum_tick_size: '0.01',
      }));

      const mockMarketsResponse = {
        data: markets,
        count: 10,
        next_cursor: 'LTE=',
      };

      mockClobClient.getMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({});

      await getClobMarkets.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      const callArgs = mockCallback.mock.calls[0][0];
      expect(callArgs.text).toContain('and 5 more markets');
    });

    it('should display filter information when applied', async () => {
      const mockMarketsResponse = {
        data: [
          {
            condition_id: 'test-condition-1',
            question: 'Test Market',
            category: 'Politics',
            active: true,
            tokens: [],
            minimum_order_size: '0.01',
            minimum_tick_size: '0.01',
          },
        ],
        count: 1,
        next_cursor: undefined,
      };

      mockClobClient.getMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({
        category: 'politics',
        active: true,
        limit: 5,
      });

      await getClobMarkets.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      const callArgs = mockCallback.mock.calls[0][0];
      expect(callArgs.text).toContain('Filters Applied');
      expect(callArgs.text).toContain('category=politics');
      expect(callArgs.text).toContain('active=true');
      expect(callArgs.text).toContain('limit=5');
    });

    it('should handle pagination cursor', async () => {
      const mockMarketsResponse = {
        data: [
          {
            condition_id: 'test-condition-1',
            question: 'Test Market',
            category: 'Test',
            active: true,
            tokens: [],
            minimum_order_size: '0.01',
            minimum_tick_size: '0.01',
          },
        ],
        count: 1,
        next_cursor: 'NEXT123',
      };

      mockClobClient.getMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({});

      await getClobMarkets.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      const callArgs = mockCallback.mock.calls[0][0];
      expect(callArgs.text).toContain('**Next**: Use cursor NEXT123 for more markets');
    });
  });

  describe('Edge Cases', () => {
    it('should handle malformed market data', async () => {
      const mockMarketsResponse = {
        data: [
          {
            // Missing required fields
            tokens: null,
            minimum_order_size: null,
            minimum_tick_size: null,
          },
        ],
        count: 1,
        next_cursor: 'LTE=',
      };

      mockClobClient.getMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({});

      const result = await getClobMarkets.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(true);
      expect(mockCallback).toHaveBeenCalled();
    });

    it('should handle null/undefined response data', async () => {
      const mockMarketsResponse = {
        data: null,
        count: 0,
        next_cursor: null,
      };

      mockClobClient.getMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({});

      const result = await getClobMarkets.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(true);
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('No CLOB markets found'),
        })
      );
    });

    it('should handle inactive markets correctly', async () => {
      const mockMarketsResponse = {
        data: [
          {
            condition_id: 'inactive-market',
            question: 'Inactive Trading Market',
            category: 'Test',
            active: false,
            tokens: [],
            minimum_order_size: '0.01',
            minimum_tick_size: '0.01',
          },
        ],
        count: 1,
        next_cursor: 'LTE=',
      };

      mockClobClient.getMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({});

      await getClobMarkets.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      const callArgs = mockCallback.mock.calls[0][0];
      expect(callArgs.text).toContain('Trading: ❌ Inactive');
    });
  });
});
