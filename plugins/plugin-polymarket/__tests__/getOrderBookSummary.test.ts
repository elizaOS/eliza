import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IAgentRuntime, Memory, State, Content } from '@elizaos/core';
import { getOrderBookSummaryAction } from '../src/actions/getOrderBookSummary';
import { initializeClobClient } from '../src/utils/clobClient';
import { callLLMWithTimeout } from '../src/utils/llmHelpers';
import type { OrderBook } from '../src/types';

// Mock dependencies
vi.mock('../src/utils/clobClient');
vi.mock('../src/utils/llmHelpers');

// Mock logger
vi.mock('@elizaos/core', async () => {
  const actual = await vi.importActual('@elizaos/core');
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

describe('getOrderBookSummaryAction', () => {
  let mockRuntime: IAgentRuntime;
  let mockMessage: Memory;
  let mockState: State;
  let mockClobClient: any;

  const mockOrderBook: OrderBook = {
    market: '0x1234567890abcdef1234567890abcdef12345678901234567890abcdef12345678',
    asset_id: '123456',
    bids: [
      { price: '0.65', size: '100.5' },
      { price: '0.64', size: '250.0' },
      { price: '0.63', size: '150.75' },
      { price: '0.62', size: '75.25' },
      { price: '0.61', size: '200.0' },
    ],
    asks: [
      { price: '0.66', size: '80.5' },
      { price: '0.67', size: '120.0' },
      { price: '0.68', size: '90.25' },
      { price: '0.69', size: '60.0' },
      { price: '0.70', size: '110.75' },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockRuntime = {
      getSetting: vi.fn(),
    } as unknown as IAgentRuntime;

    mockMessage = {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' as `${string}-${string}-${string}-${string}-${string}`,
      content: { text: 'Show order book for token 123456' },
      entityId:
        'f47ac10b-58cc-4372-a567-0e02b2c3d480' as `${string}-${string}-${string}-${string}-${string}`,
      roomId:
        'f47ac10b-58cc-4372-a567-0e02b2c3d481' as `${string}-${string}-${string}-${string}-${string}`,
      agentId:
        'f47ac10b-58cc-4372-a567-0e02b2c3d482' as `${string}-${string}-${string}-${string}-${string}`,
      createdAt: Date.now(),
    };

    mockState = {
      recentMessages: [mockMessage],
      values: {},
      data: {},
      text: '',
    } as unknown as State;

    mockClobClient = {
      getBook: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('validate', () => {
    it('should return true when CLOB_API_URL is provided', async () => {
      vi.mocked(mockRuntime.getSetting).mockReturnValue('https://clob.polymarket.com');

      const result = await getOrderBookSummaryAction.validate(mockRuntime, mockMessage, mockState);

      expect(result).toBe(true);
      expect(mockRuntime.getSetting).toHaveBeenCalledWith('CLOB_API_URL');
    });

    it('should return false when CLOB_API_URL is not provided', async () => {
      vi.mocked(mockRuntime.getSetting).mockReturnValue(undefined);

      const result = await getOrderBookSummaryAction.validate(mockRuntime, mockMessage, mockState);

      expect(result).toBe(false);
      expect(mockRuntime.getSetting).toHaveBeenCalledWith('CLOB_API_URL');
    });
  });

  describe('handler', () => {
    beforeEach(() => {
      vi.mocked(mockRuntime.getSetting).mockReturnValue('https://clob.polymarket.com');
      vi.mocked(initializeClobClient).mockResolvedValue(mockClobClient);
    });

    it('should successfully fetch order book with valid token ID', async () => {
      const mockLLMResult = {
        tokenId: '123456',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getBook).mockResolvedValue(mockOrderBook);

      const result = (await getOrderBookSummaryAction.handler(
        mockRuntime,
        mockMessage,
        mockState
      )) as Content;

      expect(result).toBeDefined();
      expect(result.text).toContain('📖 **Order Book Summary**');
      expect(result.text).toContain('Token ID: `123456`');
      expect(result.text).toContain('Bid Orders: 5');
      expect(result.text).toContain('Ask Orders: 5');
      expect(result.text).toContain('Best Bid: $0.65');
      expect(result.text).toContain('Best Ask: $0.66');
      expect(result.text).toContain('Spread: $0.0100');
      expect((result.data as any)?.orderBook).toEqual(mockOrderBook);
      expect(result.actions).toContain('GET_ORDER_BOOK');
    });

    it('should handle fallback token ID extraction from query field', async () => {
      const mockLLMResult = {
        tokenId: '',
        query: '789012',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getBook).mockResolvedValue(mockOrderBook);

      const result = (await getOrderBookSummaryAction.handler(
        mockRuntime,
        mockMessage,
        mockState
      )) as Content;

      expect(mockClobClient.getBook).toHaveBeenCalledWith('789012');
      expect(result.text).toContain('📖 **Order Book Summary**');
    });

    it('should display market depth and summary statistics', async () => {
      const mockLLMResult = {
        tokenId: '123456',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getBook).mockResolvedValue(mockOrderBook);

      const result = (await getOrderBookSummaryAction.handler(
        mockRuntime,
        mockMessage,
        mockState
      )) as Content;

      expect(result.text).toContain('**Market Depth:**');
      expect(result.text).toContain('**Best Prices:**');
      expect(result.text).toContain('**Top 5 Bids:**');
      expect(result.text).toContain('**Top 5 Asks:**');
      expect(result.text).toContain('Total Bid Size: 776.50');
      expect(result.text).toContain('Total Ask Size: 461.50');
    });

    it('should handle empty order book gracefully', async () => {
      const emptyOrderBook: OrderBook = {
        market: '0x1234567890abcdef1234567890abcdef12345678901234567890abcdef12345678',
        asset_id: '123456',
        bids: [],
        asks: [],
      };

      const mockLLMResult = {
        tokenId: '123456',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getBook).mockResolvedValue(emptyOrderBook);

      const result = (await getOrderBookSummaryAction.handler(
        mockRuntime,
        mockMessage,
        mockState
      )) as Content;

      expect(result.text).toContain('Bid Orders: 0');
      expect(result.text).toContain('Ask Orders: 0');
      expect(result.text).toContain('Best Bid: No bids available');
      expect(result.text).toContain('Best Ask: No asks available');
      expect(result.text).toContain('Spread: N/A');
    });

    it('should handle order book with only bids', async () => {
      const bidsOnlyOrderBook: OrderBook = {
        market: '0x1234567890abcdef1234567890abcdef12345678901234567890abcdef12345678',
        asset_id: '123456',
        bids: [
          { price: '0.65', size: '100.0' },
          { price: '0.64', size: '50.0' },
        ],
        asks: [],
      };

      const mockLLMResult = {
        tokenId: '123456',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getBook).mockResolvedValue(bidsOnlyOrderBook);

      const result = (await getOrderBookSummaryAction.handler(
        mockRuntime,
        mockMessage,
        mockState
      )) as Content;

      expect(result.text).toContain('Bid Orders: 2');
      expect(result.text).toContain('Ask Orders: 0');
      expect(result.text).toContain('Best Bid: $0.65');
      expect(result.text).toContain('Best Ask: No asks available');
      expect(result.text).toContain('**Top 5 Bids:**');
      expect(result.text).not.toContain('**Top 5 Asks:**');
    });

    it('should throw error when CLOB_API_URL is not configured', async () => {
      vi.mocked(mockRuntime.getSetting).mockReturnValue(undefined);

      await expect(
        getOrderBookSummaryAction.handler(mockRuntime, mockMessage, mockState)
      ).rejects.toThrow('CLOB_API_URL is required in configuration.');
    });

    it('should throw error when LLM returns error', async () => {
      const mockLLMResult = {
        error: 'No token ID found',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);

      await expect(
        getOrderBookSummaryAction.handler(mockRuntime, mockMessage, mockState)
      ).rejects.toThrow(
        'Token identifier not found. Please specify a token ID for the order book.'
      );
    });

    it('should throw error when no valid token ID is extracted', async () => {
      const mockLLMResult = {
        tokenId: '',
        query: 'not-a-number',
      };

      // Create a mock message without a valid token ID
      const mockMessageWithoutToken = {
        ...mockMessage,
        content: { text: 'Show me an order book without any token' },
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);

      await expect(
        getOrderBookSummaryAction.handler(mockRuntime, mockMessageWithoutToken, mockState)
      ).rejects.toThrow(
        'Unable to extract token ID from your message. Please provide a valid token ID.'
      );
    });

    it('should throw error when LLM call fails', async () => {
      // Create a mock message without a valid token ID
      const mockMessageWithoutToken = {
        ...mockMessage,
        content: { text: 'Show me some order book data' },
      };

      vi.mocked(callLLMWithTimeout).mockRejectedValue(new Error('LLM timeout'));

      await expect(
        getOrderBookSummaryAction.handler(mockRuntime, mockMessageWithoutToken, mockState)
      ).rejects.toThrow(
        'Unable to extract token ID from your message. Please provide a valid token ID.'
      );
    });

    it('should throw error when order book is not found', async () => {
      const mockLLMResult = {
        tokenId: '123456',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getBook).mockResolvedValue(null);

      await expect(
        getOrderBookSummaryAction.handler(mockRuntime, mockMessage, mockState)
      ).rejects.toThrow('Order book not found for token ID: 123456');
    });

    it('should throw error when CLOB client getBook fails', async () => {
      const mockLLMResult = {
        tokenId: '123456',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getBook).mockRejectedValue(new Error('API Error'));

      await expect(
        getOrderBookSummaryAction.handler(mockRuntime, mockMessage, mockState)
      ).rejects.toThrow('API Error');
    });

    it('should handle callback function properly on success', async () => {
      const mockCallback = vi.fn();
      const mockLLMResult = {
        tokenId: '123456',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getBook).mockResolvedValue(mockOrderBook);

      const result = await getOrderBookSummaryAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(mockCallback).toHaveBeenCalledWith(result);
      expect(mockCallback).toHaveBeenCalledTimes(1);
    });

    it('should handle callback function properly on error', async () => {
      const mockCallback = vi.fn();
      const mockLLMResult = {
        error: 'No token ID found',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);

      await expect(
        getOrderBookSummaryAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow();

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('❌ **Error**'),
          actions: ['GET_ORDER_BOOK'],
          data: expect.objectContaining({ error: expect.any(String) }),
        })
      );
    });

    it('should validate numeric token ID pattern correctly', async () => {
      const testCases = [
        { id: '123456', valid: true },
        { id: '999999999', valid: true },
        { id: '0', valid: true },
        { id: 'abc123', valid: false },
        { id: '123abc', valid: false },
        { id: '', valid: false },
      ];

      for (const testCase of testCases) {
        const mockLLMResult = {
          tokenId: '',
          query: testCase.id,
        };

        // Create a specific mock message for each test case
        const testMessage = {
          ...mockMessage,
          content: {
            text: testCase.valid
              ? `Get order book for token ${testCase.id}`
              : `Show me data for ${testCase.id}`,
          },
        };

        vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);

        if (testCase.valid) {
          vi.mocked(mockClobClient.getBook).mockResolvedValue(mockOrderBook);
          const result = (await getOrderBookSummaryAction.handler(
            mockRuntime,
            testMessage,
            mockState
          )) as Content;
          expect(result.text).toContain('📖 **Order Book Summary**');
        } else {
          await expect(
            getOrderBookSummaryAction.handler(mockRuntime, testMessage, mockState)
          ).rejects.toThrow();
        }
      }
    });

    it('should include summary statistics in response data', async () => {
      const mockLLMResult = {
        tokenId: '123456',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getBook).mockResolvedValue(mockOrderBook);

      const result = (await getOrderBookSummaryAction.handler(
        mockRuntime,
        mockMessage,
        mockState
      )) as Content;

      const data = result.data as any;
      expect(data.summary).toBeDefined();
      expect(data.summary.bidCount).toBe(5);
      expect(data.summary.askCount).toBe(5);
      expect(data.summary.bestBid).toEqual({ price: '0.65', size: '100.5' });
      expect(data.summary.bestAsk).toEqual({ price: '0.66', size: '80.5' });
      expect(data.summary.spread).toBe('0.0100');
      expect(data.summary.totalBidSize).toBe(776.5);
      expect(data.summary.totalAskSize).toBe(461.5);
    });
  });

  describe('action metadata', () => {
    it('should have correct action name', () => {
      expect(getOrderBookSummaryAction.name).toBe('GET_ORDER_BOOK');
    });

    it('should have appropriate similes', () => {
      expect(getOrderBookSummaryAction.similes).toContain('ORDER_BOOK');
      expect(getOrderBookSummaryAction.similes).toContain('BOOK_SUMMARY');
      expect(getOrderBookSummaryAction.similes).toContain('GET_BOOK');
      expect(getOrderBookSummaryAction.similes).toContain('SHOW_BOOK');
      expect(getOrderBookSummaryAction.similes).toContain('BID_ASK');
    });

    it('should have meaningful description', () => {
      expect(getOrderBookSummaryAction.description).toContain('Retrieve order book summary');
      expect(getOrderBookSummaryAction.description).toContain('bids and asks');
      expect(getOrderBookSummaryAction.description).toContain('Polymarket token');
    });

    it('should have proper examples', () => {
      expect(getOrderBookSummaryAction.examples).toBeDefined();
      expect(Array.isArray(getOrderBookSummaryAction.examples)).toBe(true);
      if (getOrderBookSummaryAction.examples) {
        expect(getOrderBookSummaryAction.examples.length).toBeGreaterThan(0);
      }
    });
  });
});
