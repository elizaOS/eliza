import { describe, it, expect, beforeEach, vi, type MockedFunction } from 'vitest';
import { type IAgentRuntime, type Memory, type State, type HandlerCallback } from '@elizaos/core';
import { getBestPriceAction } from '../src/actions/getBestPrice';
import { initializeClobClient } from '../src/utils/clobClient';
import { callLLMWithTimeout } from '../src/utils/llmHelpers';

// Mock the dependencies
vi.mock('../src/utils/clobClient');
vi.mock('../src/utils/llmHelpers');

const mockInitializeClobClient = initializeClobClient as MockedFunction<
  typeof initializeClobClient
>;
const mockCallLLMWithTimeout = callLLMWithTimeout as MockedFunction<typeof callLLMWithTimeout>;

describe('getBestPrice Action', () => {
  let mockRuntime: IAgentRuntime;
  let mockMemory: Memory;
  let mockState: State;
  let mockCallback: HandlerCallback;
  let mockClobClient: any;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Setup mock runtime
    mockRuntime = {
      getSetting: vi.fn((key: string) => {
        if (key === 'CLOB_API_URL') return 'https://clob.polymarket.com';
        return undefined;
      }),
    } as any;

    // Setup mock memory
    mockMemory = {
      content: {
        text: 'Get best price for token 123456 on buy side',
      },
    } as Memory;

    // Setup mock state
    mockState = {} as State;

    // Setup mock callback
    mockCallback = vi.fn();

    // Setup mock CLOB client
    mockClobClient = {
      getPrice: vi.fn(),
    };

    mockInitializeClobClient.mockResolvedValue(mockClobClient);
  });

  describe('validate', () => {
    it('should return false when CLOB_API_URL is not provided', async () => {
      const mockRuntimeNoUrl = {
        getSetting: vi.fn(() => undefined),
      } as any;

      const result = await getBestPriceAction.validate(mockRuntimeNoUrl, mockMemory, mockState);
      expect(result).toBe(false);
    });

    it('should return true when message contains price-related keywords', async () => {
      const testCases = [
        'Get best price for token 123456',
        'What is the bid for this token?',
        'Show me the ask price',
        'BEST_PRICE token 456789',
      ];

      for (const text of testCases) {
        const memory = { content: { text } } as Memory;
        const result = await getBestPriceAction.validate(mockRuntime, memory, mockState);
        expect(result).toBe(true);
      }
    });

    it('should return false when message does not contain price-related keywords', async () => {
      const memory = { content: { text: 'Hello world' } } as Memory;
      const result = await getBestPriceAction.validate(mockRuntime, memory, mockState);
      expect(result).toBe(false);
    });
  });

  describe('handler', () => {
    it('should successfully get price using LLM extraction', async () => {
      // Setup LLM to return valid parameters
      mockCallLLMWithTimeout.mockResolvedValue({
        tokenId: '123456',
        side: 'buy',
      });

      // Setup CLOB client to return price
      mockClobClient.getPrice.mockResolvedValue({
        price: '0.5500',
      });

      const result = await getBestPriceAction.handler(
        mockRuntime,
        mockMemory,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBeDefined();
      expect(result.text).toContain('Best Ask (buy) Price for Token 123456');
      expect(result.text).toContain('$0.5500 (55.00%)');
      expect(result.data.tokenId).toBe('123456');
      expect(result.data.side).toBe('buy');
      expect(mockCallback).toHaveBeenCalledWith(result);
    });

    it('should fallback to regex extraction when LLM fails', async () => {
      // Setup LLM to fail
      mockCallLLMWithTimeout.mockRejectedValue(new Error('LLM failed'));

      // Setup CLOB client to return price
      mockClobClient.getPrice.mockResolvedValue({
        price: '0.3250',
      });

      // Setup memory with regex-extractable content
      const memory = {
        content: { text: 'Show me the sell price for token 789012' },
      } as Memory;

      const result = await getBestPriceAction.handler(
        mockRuntime,
        memory,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBeDefined();
      expect(result.text).toContain('Best Bid (sell) Price for Token 789012');
      expect(result.text).toContain('$0.3250 (32.50%)');
      expect(result.data.tokenId).toBe('789012');
      expect(result.data.side).toBe('sell');
    });

    it('should handle bid/ask mapping correctly', async () => {
      const testCases = [
        { input: 'best bid for token 123456', expectedSide: 'sell' },
        { input: 'best ask for token 123456', expectedSide: 'buy' },
        { input: 'buy price for token 123456', expectedSide: 'buy' },
        { input: 'sell price for token 123456', expectedSide: 'sell' },
      ];

      for (const testCase of testCases) {
        vi.clearAllMocks();
        mockCallLLMWithTimeout.mockRejectedValue(new Error('LLM failed'));
        mockClobClient.getPrice.mockResolvedValue({ price: '0.5000' });

        const memory = { content: { text: testCase.input } } as Memory;

        const result = await getBestPriceAction.handler(
          mockRuntime,
          memory,
          mockState,
          {},
          mockCallback
        );

        expect(result.data.side).toBe(testCase.expectedSide);
      }
    });

    it('should default to buy side when no side is specified', async () => {
      mockCallLLMWithTimeout.mockRejectedValue(new Error('LLM failed'));
      mockClobClient.getPrice.mockResolvedValue({ price: '0.5000' });

      const memory = { content: { text: 'price for token 123456' } } as Memory;

      const result = await getBestPriceAction.handler(
        mockRuntime,
        memory,
        mockState,
        {},
        mockCallback
      );

      expect(result.data.side).toBe('buy');
    });

    it('should throw error when no token ID is found', async () => {
      mockCallLLMWithTimeout.mockRejectedValue(new Error('LLM failed'));

      const memory = { content: { text: 'get me some price data' } } as Memory;

      await expect(
        getBestPriceAction.handler(mockRuntime, memory, mockState, {}, mockCallback)
      ).rejects.toThrow('Please provide a token ID to get the price for.');

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Please provide a token ID'),
        })
      );
    });

    it('should throw error when CLOB_API_URL is not configured', async () => {
      const mockRuntimeNoUrl = {
        getSetting: vi.fn(() => undefined),
      } as any;

      await expect(
        getBestPriceAction.handler(mockRuntimeNoUrl, mockMemory, mockState, {}, mockCallback)
      ).rejects.toThrow('CLOB_API_URL is required in configuration.');
    });

    it('should handle CLOB client errors gracefully', async () => {
      mockCallLLMWithTimeout.mockResolvedValue({
        tokenId: '123456',
        side: 'buy',
      });

      mockClobClient.getPrice.mockRejectedValue(new Error('Network error'));

      await expect(
        getBestPriceAction.handler(mockRuntime, mockMemory, mockState, {}, mockCallback)
      ).rejects.toThrow('Network error');

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Error getting best price'),
        })
      );
    });

    it('should handle empty price response', async () => {
      mockCallLLMWithTimeout.mockResolvedValue({
        tokenId: '123456',
        side: 'buy',
      });

      mockClobClient.getPrice.mockResolvedValue(null);

      await expect(
        getBestPriceAction.handler(mockRuntime, mockMemory, mockState, {}, mockCallback)
      ).rejects.toThrow('No price data available for token 123456');
    });

    it('should handle invalid price response', async () => {
      mockCallLLMWithTimeout.mockResolvedValue({
        tokenId: '123456',
        side: 'buy',
      });

      mockClobClient.getPrice.mockResolvedValue({
        price: null,
      });

      await expect(
        getBestPriceAction.handler(mockRuntime, mockMemory, mockState, {}, mockCallback)
      ).rejects.toThrow('No price data available for token 123456');
    });

    it('should format price correctly for different values', async () => {
      const testPrices = [
        { price: '0.0001', expectedFormatted: '0.0001', expectedPercentage: '0.01' },
        { price: '0.5500', expectedFormatted: '0.5500', expectedPercentage: '55.00' },
        { price: '0.9999', expectedFormatted: '0.9999', expectedPercentage: '99.99' },
        { price: '1.0000', expectedFormatted: '1.0000', expectedPercentage: '100.00' },
      ];

      for (const testPrice of testPrices) {
        vi.clearAllMocks();
        mockCallLLMWithTimeout.mockResolvedValue({
          tokenId: '123456',
          side: 'buy',
        });

        mockClobClient.getPrice.mockResolvedValue({
          price: testPrice.price,
        });

        const result = await getBestPriceAction.handler(
          mockRuntime,
          mockMemory,
          mockState,
          {},
          mockCallback
        );

        expect(result.data.formattedPrice).toBe(testPrice.expectedFormatted);
        expect(result.data.percentagePrice).toBe(testPrice.expectedPercentage);
        expect(result.text).toContain(
          `$${testPrice.expectedFormatted} (${testPrice.expectedPercentage}%)`
        );
      }
    });

    it('should include timestamp in response data', async () => {
      mockCallLLMWithTimeout.mockResolvedValue({
        tokenId: '123456',
        side: 'buy',
      });

      mockClobClient.getPrice.mockResolvedValue({
        price: '0.5500',
      });

      const result = await getBestPriceAction.handler(
        mockRuntime,
        mockMemory,
        mockState,
        {},
        mockCallback
      );

      expect(result.data.timestamp).toBeDefined();
      expect(new Date(result.data.timestamp)).toBeInstanceOf(Date);
    });

    it('should handle very long token IDs', async () => {
      const longTokenId =
        '71321045679252212594626385532706912750332728571942532289631379312455583992563';

      mockCallLLMWithTimeout.mockResolvedValue({
        tokenId: longTokenId,
        side: 'buy',
      });

      mockClobClient.getPrice.mockResolvedValue({
        price: '0.5500',
      });

      const result = await getBestPriceAction.handler(
        mockRuntime,
        mockMemory,
        mockState,
        {},
        mockCallback
      );

      expect(result.data.tokenId).toBe(longTokenId);
      expect(result.text).toContain(longTokenId);
    });
  });

  describe('examples', () => {
    it('should have proper example structure', () => {
      expect(getBestPriceAction.examples).toBeDefined();
      expect(Array.isArray(getBestPriceAction.examples)).toBe(true);
      expect(getBestPriceAction.examples.length).toBeGreaterThan(0);

      for (const example of getBestPriceAction.examples) {
        expect(Array.isArray(example)).toBe(true);
        expect(example.length).toBe(2);

        const [userMessage, agentMessage] = example;
        expect(userMessage.name).toBeDefined();
        expect(userMessage.content.text).toBeDefined();
        expect(agentMessage.name).toBeDefined();
        expect(agentMessage.content.text).toBeDefined();
        expect(agentMessage.content.actions).toContain('GET_BEST_PRICE');
      }
    });
  });

  describe('action metadata', () => {
    it('should have correct name and similes', () => {
      expect(getBestPriceAction.name).toBe('GET_BEST_PRICE');
      expect(Array.isArray(getBestPriceAction.similes)).toBe(true);
      expect(getBestPriceAction.similes).toContain('BEST_PRICE');
      expect(getBestPriceAction.similes).toContain('GET_PRICE');
    });

    it('should have description', () => {
      expect(getBestPriceAction.description).toBeDefined();
      expect(typeof getBestPriceAction.description).toBe('string');
    });
  });
});
