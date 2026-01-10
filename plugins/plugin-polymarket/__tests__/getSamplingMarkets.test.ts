import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import { getSamplingMarkets } from '../src/actions/getSamplingMarkets';
import { initializeClobClient } from '../src/utils/clobClient';
import { callLLMWithTimeout } from '../src/utils/llmHelpers';

// Mock the dependencies
vi.mock('../src/utils/clobClient');
vi.mock('../src/utils/llmHelpers');

const mockInitializeClobClient = vi.mocked(initializeClobClient);
const mockCallLLMWithTimeout = vi.mocked(callLLMWithTimeout);

describe('getSamplingMarkets Action', () => {
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
      content: { text: 'Get sampling markets' },
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
      getSamplingMarkets: vi.fn(),
    };

    mockInitializeClobClient.mockResolvedValue(mockClobClient);
  });

  describe('Action Properties', () => {
    it('should have correct action properties', () => {
      expect(getSamplingMarkets.name).toBe('GET_SAMPLING_MARKETS');
      expect(getSamplingMarkets.description).toContain('rewards enabled');
      expect(getSamplingMarkets.similes).toContain('SAMPLING_MARKETS');
      expect(getSamplingMarkets.similes).toContain('REWARD_MARKETS');
      expect(getSamplingMarkets.similes).toContain('LIQUIDITY_REWARDS');
    });

    it('should have comprehensive trigger words', () => {
      const expectedTriggers = [
        'SAMPLING_MARKETS',
        'GET_SAMPLING_MARKETS',
        'REWARD_MARKETS',
        'MARKETS_WITH_REWARDS',
        'INCENTIVE_MARKETS',
        'SAMPLING',
        'REWARDS_ENABLED',
        'LIQUIDITY_REWARDS',
        'MARKET_REWARDS',
        'EARNING_MARKETS',
        'INCENTIVIZED_MARKETS',
        'REWARD_ELIGIBLE',
        'BONUS_MARKETS',
        'EARN_REWARDS',
        'LIQUIDITY_MINING',
        'GET_REWARD_MARKETS',
        'SHOW_SAMPLING_MARKETS',
        'LIST_SAMPLING_MARKETS',
      ];

      for (const trigger of expectedTriggers) {
        expect(getSamplingMarkets.similes).toContain(trigger);
      }
    });

    it('should have examples with correct format', () => {
      expect(getSamplingMarkets.examples).toBeDefined();
      expect(Array.isArray(getSamplingMarkets.examples || [])).toBe(true);
      expect((getSamplingMarkets.examples || []).length).toBeGreaterThan(0);
    });
  });

  describe('Validation', () => {
    it('should always validate as true', async () => {
      const result = await getSamplingMarkets.validate(mockRuntime, mockMessage);
      expect(result).toBe(true);
    });
  });

  describe('Successful Execution', () => {
    it('should successfully retrieve sampling markets', async () => {
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
            rewards: {
              min_size: 10,
              max_spread: 2,
            },
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
            rewards: {
              min_size: 5,
              max_spread: 1.5,
            },
          },
        ],
        count: 2,
        next_cursor: 'ABC123',
      };

      mockClobClient.getSamplingMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({});

      const result = await getSamplingMarkets.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(true);
      expect(mockClobClient.getSamplingMarkets).toHaveBeenCalledWith(undefined);
      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('Sampling Markets (Rewards Enabled)'),
        content: {
          action: 'sampling_markets_retrieved',
          markets: mockMarketsResponse.data,
          count: 2,
          next_cursor: 'ABC123',
          timestamp: expect.any(String),
        },
      });
    });

    it('should handle pagination with cursor', async () => {
      const mockMarketsResponse = {
        data: [
          {
            condition_id: 'test-condition-3',
            question: 'Will Fed cut rates in March?',
            category: 'Economics',
            active: true,
            tokens: [],
            rewards: {},
          },
        ],
        count: 1,
        next_cursor: 'LTE=',
      };

      mockClobClient.getSamplingMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({ next_cursor: 'XYZ789' });

      const result = await getSamplingMarkets.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(true);
      expect(mockClobClient.getSamplingMarkets).toHaveBeenCalledWith('XYZ789');
      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('End of results'),
        content: expect.objectContaining({
          action: 'sampling_markets_retrieved',
          next_cursor: 'LTE=',
        }),
      });
    });

    it('should handle empty markets response', async () => {
      const mockMarketsResponse = {
        data: [],
        count: 0,
        next_cursor: 'LTE=',
      };

      mockClobClient.getSamplingMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({});

      const result = await getSamplingMarkets.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(true);
      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('No sampling markets found'),
        content: expect.objectContaining({
          action: 'sampling_markets_retrieved',
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
            rewards: {},
          },
        ],
        count: 1,
        next_cursor: null,
      };

      mockClobClient.getSamplingMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({});

      const result = await getSamplingMarkets.handler(
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
          action: 'sampling_markets_retrieved',
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

      mockClobClient.getSamplingMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({ next_cursor: 'CURSOR123' });

      await getSamplingMarkets.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallLLMWithTimeout).toHaveBeenCalledWith(
        mockRuntime,
        mockState,
        expect.stringContaining('sampling markets'),
        'getSamplingMarkets',
        30000
      );
      expect(mockClobClient.getSamplingMarkets).toHaveBeenCalledWith('CURSOR123');
    });

    it('should handle LLM extraction failure gracefully', async () => {
      const mockMarketsResponse = {
        data: [],
        count: 0,
        next_cursor: 'LTE=',
      };

      mockClobClient.getSamplingMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockRejectedValue(new Error('LLM timeout'));

      const result = await getSamplingMarkets.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(true);
      expect(mockClobClient.getSamplingMarkets).toHaveBeenCalledWith(undefined);
    });

    it('should handle LLM error response', async () => {
      const mockMarketsResponse = {
        data: [],
        count: 0,
        next_cursor: 'LTE=',
      };

      mockClobClient.getSamplingMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({ error: 'No cursor found' });

      const result = await getSamplingMarkets.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(true);
      expect(mockClobClient.getSamplingMarkets).toHaveBeenCalledWith(undefined);
    });
  });

  describe('Error Handling', () => {
    it('should handle CLOB client initialization failure', async () => {
      mockInitializeClobClient.mockRejectedValue(new Error('Client init failed'));

      const result = await getSamplingMarkets.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(false);
      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('Error getting sampling markets'),
        content: {
          action: 'sampling_markets_error',
          error: 'Client init failed',
          timestamp: expect.any(String),
        },
      });
    });

    it('should handle API call failure', async () => {
      mockClobClient.getSamplingMarkets.mockRejectedValue(new Error('API error'));
      mockCallLLMWithTimeout.mockResolvedValue({});

      const result = await getSamplingMarkets.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(false);
      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('Error getting sampling markets'),
        content: {
          action: 'sampling_markets_error',
          error: 'API error',
          timestamp: expect.any(String),
        },
      });
    });

    it('should handle unknown error types', async () => {
      mockClobClient.getSamplingMarkets.mockRejectedValue('String error');
      mockCallLLMWithTimeout.mockResolvedValue({});

      const result = await getSamplingMarkets.handler(
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
          action: 'sampling_markets_error',
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

      mockClobClient.getSamplingMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({});

      const result = await getSamplingMarkets.handler(
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
    it('should format response with reward information', async () => {
      const mockMarketsResponse = {
        data: [
          {
            condition_id: 'test-condition-1',
            question: 'Test Market Question',
            category: 'Test',
            active: true,
            tokens: [
              { token_id: 'token-1', outcome: 'Yes' },
              { token_id: 'token-2', outcome: 'No' },
            ],
            rewards: {
              min_size: 100,
              max_spread: 5,
            },
          },
        ],
        count: 1,
        next_cursor: 'ABC123',
      };

      mockClobClient.getSamplingMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({});

      await getSamplingMarkets.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      const callArgs = mockCallback.mock.calls[0][0];
      expect(callArgs.text).toContain('Test Market Question');
      expect(callArgs.text).toContain('Category: Test');
      expect(callArgs.text).toContain('Min $100');
      expect(callArgs.text).toContain('Max 5% spread');
      expect(callArgs.text).toContain('cursor ABC123');
    });

    it('should handle large number of markets by truncating display', async () => {
      const markets = Array.from({ length: 10 }, (_, i) => ({
        condition_id: `condition-${i}`,
        question: `Market Question ${i}`,
        category: 'Test',
        active: true,
        tokens: [],
        rewards: {},
      }));

      const mockMarketsResponse = {
        data: markets,
        count: 10,
        next_cursor: 'LTE=',
      };

      mockClobClient.getSamplingMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({});

      await getSamplingMarkets.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      const callArgs = mockCallback.mock.calls[0][0];
      expect(callArgs.text).toContain('and 5 more markets');
    });

    it('should handle missing next cursor', async () => {
      const mockMarketsResponse = {
        data: [
          {
            condition_id: 'test-condition-1',
            question: 'Test Market',
            category: 'Test',
            active: true,
            tokens: [],
            rewards: {},
          },
        ],
        count: 1,
        next_cursor: undefined,
      };

      mockClobClient.getSamplingMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({});

      await getSamplingMarkets.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      const callArgs = mockCallback.mock.calls[0][0];
      expect(callArgs.text).toContain('End of results');
    });
  });

  describe('Edge Cases', () => {
    it('should handle malformed market data', async () => {
      const mockMarketsResponse = {
        data: [
          {
            // Missing required fields
            tokens: null,
            rewards: null,
          },
        ],
        count: 1,
        next_cursor: 'LTE=',
      };

      mockClobClient.getSamplingMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({});

      const result = await getSamplingMarkets.handler(
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

      mockClobClient.getSamplingMarkets.mockResolvedValue(mockMarketsResponse);
      mockCallLLMWithTimeout.mockResolvedValue({});

      const result = await getSamplingMarkets.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(true);
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('No sampling markets found'),
        })
      );
    });
  });
});
