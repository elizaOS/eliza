import { describe, it, expect, vi, beforeEach } from 'vitest';
import { retrieveAllMarketsAction } from '../actions/retrieveAllMarkets';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';

// Mock the dependencies
vi.mock('../utils/llmHelpers', () => ({
  callLLMWithTimeout: vi.fn(),
}));

vi.mock('../utils/clobClient', () => ({
  initializeClobClient: vi.fn(),
}));

describe('retrieveAllMarketsAction', () => {
  let mockRuntime: IAgentRuntime;
  let mockMessage: Memory;
  let mockState: State;
  let mockCallback: any;

  beforeEach(() => {
    mockRuntime = {
      getSetting: vi.fn(),
      useModel: vi.fn(),
    } as any;

    mockMessage = {
      id: 'test-id',
      content: { text: 'Get all markets' },
      userId: 'test-user',
      roomId: 'test-room',
      agentId: 'test-agent',
      createdAt: Date.now(),
    };

    mockState = {
      agentId: 'test-agent',
      bio: 'Test bio',
      lore: 'Test lore',
      recentMessages: [],
      providers: [],
      messageDirections: 'outgoing',
      actions: [],
      evaluators: [],
      responseData: {},
    };

    mockCallback = vi.fn();
  });

  describe('validate', () => {
    it('should return true when CLOB_API_URL is provided', async () => {
      vi.mocked(mockRuntime.getSetting).mockReturnValue('https://clob.polymarket.com');

      const result = await retrieveAllMarketsAction.validate(mockRuntime, mockMessage, mockState);

      expect(result).toBe(true);
      expect(mockRuntime.getSetting).toHaveBeenCalledWith('CLOB_API_URL');
    });

    it('should return false when CLOB_API_URL is not provided', async () => {
      vi.mocked(mockRuntime.getSetting).mockReturnValue(undefined);

      const result = await retrieveAllMarketsAction.validate(mockRuntime, mockMessage, mockState);

      expect(result).toBe(false);
    });
  });

  describe('handler', () => {
    it('should fetch and return markets successfully', async () => {
      const mockMarkets = [
        {
          question: 'Will BTC reach $100k?',
          category: 'crypto',
          active: true,
          end_date_iso: '2024-12-31T23:59:59Z',
        },
        {
          question: 'Who will win the election?',
          category: 'politics',
          active: true,
          end_date_iso: '2024-11-05T23:59:59Z',
        },
      ];

      const mockResponse = {
        data: mockMarkets,
        count: 2,
        limit: 100,
        next_cursor: 'LTE=',
      };

      const mockClobClient = {
        getMarkets: vi.fn().mockResolvedValue(mockResponse),
      };

      vi.mocked(mockRuntime.getSetting).mockReturnValue('https://clob.polymarket.com');

      const { callLLMWithTimeout } = await import('../utils/llmHelpers');
      const { initializeClobClient } = await import('../utils/clobClient');

      vi.mocked(callLLMWithTimeout).mockResolvedValue({});
      vi.mocked(initializeClobClient).mockResolvedValue(mockClobClient);

      const result = await retrieveAllMarketsAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result.text).toContain('Retrieved 2 Polymarket prediction markets');
      expect(result.text).toContain('Will BTC reach $100k?');
      expect(result.text).toContain('Who will win the election?');
      expect(result.actions).toContain('GET_ALL_MARKETS');
      expect(result.data.markets).toEqual(mockMarkets);
      expect(result.data.count).toBe(2);
      expect(mockCallback).toHaveBeenCalledWith(result);
    });

    it('should handle empty markets response', async () => {
      const mockResponse = {
        data: [],
        count: 0,
        limit: 100,
        next_cursor: 'LTE=',
      };

      const mockClobClient = {
        getMarkets: vi.fn().mockResolvedValue(mockResponse),
      };

      vi.mocked(mockRuntime.getSetting).mockReturnValue('https://clob.polymarket.com');

      const { callLLMWithTimeout } = await import('../utils/llmHelpers');
      const { initializeClobClient } = await import('../utils/clobClient');

      vi.mocked(callLLMWithTimeout).mockResolvedValue({});
      vi.mocked(initializeClobClient).mockResolvedValue(mockClobClient);

      const result = await retrieveAllMarketsAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result.text).toContain('Retrieved 0 Polymarket prediction markets');
      expect(result.text).toContain('No markets found matching your criteria');
      expect(result.data.count).toBe(0);
    });

    it('should handle CLOB API errors', async () => {
      const mockClobClient = {
        getMarkets: vi
          .fn()
          .mockRejectedValue(new Error('CLOB API error: 500 Internal Server Error')),
      };

      vi.mocked(mockRuntime.getSetting).mockReturnValue('https://clob.polymarket.com');

      const { callLLMWithTimeout } = await import('../utils/llmHelpers');
      const { initializeClobClient } = await import('../utils/clobClient');

      vi.mocked(callLLMWithTimeout).mockResolvedValue({});
      vi.mocked(initializeClobClient).mockResolvedValue(mockClobClient);

      await expect(
        retrieveAllMarketsAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('CLOB API error: 500 Internal Server Error');

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Error retrieving markets'),
          data: expect.objectContaining({
            error: 'CLOB API error: 500 Internal Server Error',
          }),
        })
      );
    });

    it('should handle missing CLOB_API_URL in handler', async () => {
      vi.mocked(mockRuntime.getSetting).mockReturnValue(undefined);

      await expect(
        retrieveAllMarketsAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('CLOB_API_URL is required in configuration.');

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'CLOB_API_URL is required in configuration.',
          data: expect.objectContaining({
            error: 'CLOB_API_URL is required in configuration.',
          }),
        })
      );
    });
  });

  describe('action properties', () => {
    it('should have correct action name and similes', () => {
      expect(retrieveAllMarketsAction.name).toBe('GET_ALL_MARKETS');
      expect(retrieveAllMarketsAction.similes).toContain('LIST_MARKETS');
      expect(retrieveAllMarketsAction.similes).toContain('SHOW_MARKETS');
      expect(retrieveAllMarketsAction.similes).toContain('GET_MARKETS');
    });

    it('should have proper description', () => {
      expect(retrieveAllMarketsAction.description).toBe(
        'Retrieve all available prediction markets from Polymarket'
      );
    });

    it('should have example conversations', () => {
      expect(retrieveAllMarketsAction.examples).toBeDefined();
      expect(retrieveAllMarketsAction.examples.length).toBeGreaterThan(0);

      const firstExample = retrieveAllMarketsAction.examples[0];
      expect(firstExample[0].content.text).toContain('prediction markets');
      expect(firstExample[1].content.actions).toContain('GET_ALL_MARKETS');
    });
  });
});
