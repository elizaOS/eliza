import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IAgentRuntime, Memory, State, Content } from '@elizaos/core';
import { getOrderBookDepthAction } from '../src/actions/getOrderBookDepth';
import { initializeClobClient, type BookParams } from '../src/utils/clobClient';
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

describe('getOrderBookDepthAction', () => {
  let mockRuntime: IAgentRuntime;
  let mockMessage: Memory;
  let mockState: State;
  let mockClobClient: any;

  const mockSingleOrderBook: OrderBook = {
    market: '0x1234567890abcdef1234567890abcdef12345678901234567890abcdef12345678',
    asset_id: '123456',
    bids: [
      { price: '0.65', size: '100.5' },
      { price: '0.64', size: '250.0' },
      { price: '0.63', size: '150.75' },
    ],
    asks: [
      { price: '0.66', size: '80.5' },
      { price: '0.67', size: '120.0' },
      { price: '0.68', size: '90.25' },
    ],
  };

  const mockMultipleOrderBooks: OrderBook[] = [
    {
      market: '0x1234567890abcdef1234567890abcdef12345678901234567890abcdef12345678',
      asset_id: '123456',
      bids: [
        { price: '0.65', size: '100.5' },
        { price: '0.64', size: '250.0' },
      ],
      asks: [
        { price: '0.66', size: '80.5' },
        { price: '0.67', size: '120.0' },
      ],
    },
    {
      market: '0x9876543210fedcba9876543210fedcba98765432109876543210fedcba98765432',
      asset_id: '789012',
      bids: [
        { price: '0.45', size: '200.0' },
        { price: '0.44', size: '150.5' },
      ],
      asks: [
        { price: '0.46', size: '175.0' },
        { price: '0.47', size: '100.25' },
      ],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();

    mockRuntime = {
      getSetting: vi.fn(),
    } as unknown as IAgentRuntime;

    mockMessage = {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' as `${string}-${string}-${string}-${string}-${string}`,
      content: { text: 'Show order book depth for token 123456' },
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
      getOrderBooks: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('validate', () => {
    it('should return true when CLOB_API_URL is provided', async () => {
      vi.mocked(mockRuntime.getSetting).mockReturnValue('https://clob.polymarket.com');

      const result = await getOrderBookDepthAction.validate(mockRuntime, mockMessage, mockState);

      expect(result).toBe(true);
      expect(mockRuntime.getSetting).toHaveBeenCalledWith('CLOB_API_URL');
    });

    it('should return false when CLOB_API_URL is not provided', async () => {
      vi.mocked(mockRuntime.getSetting).mockReturnValue(undefined);

      const result = await getOrderBookDepthAction.validate(mockRuntime, mockMessage, mockState);

      expect(result).toBe(false);
      expect(mockRuntime.getSetting).toHaveBeenCalledWith('CLOB_API_URL');
    });
  });

  describe('handler', () => {
    beforeEach(() => {
      vi.mocked(mockRuntime.getSetting).mockReturnValue('https://clob.polymarket.com');
      vi.mocked(initializeClobClient).mockResolvedValue(mockClobClient);
    });

    it('should successfully fetch single order book with valid token ID', async () => {
      const mockLLMResult = {
        tokenIds: ['123456'],
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getOrderBooks).mockResolvedValue([mockSingleOrderBook]);

      const result = (await getOrderBookDepthAction.handler(
        mockRuntime,
        mockMessage,
        mockState
      )) as Content;

      expect(result).toBeDefined();
      expect(result.text).toContain('📊 **Order Book Depth Summary**');
      expect(result.text).toContain('**Tokens Requested**: 1');
      expect(result.text).toContain('**Order Books Found**: 1');
      expect(result.text).toContain('**Token 1: `123456`**');
      expect(result.text).toContain('Bid Levels: 3');
      expect(result.text).toContain('Ask Levels: 3');
      expect(result.text).toContain('Best Bid: $0.65 (100.5)');
      expect(result.text).toContain('Best Ask: $0.66 (80.5)');
      expect((result.data as any)?.orderBooks).toEqual([mockSingleOrderBook]);
      expect(result.actions).toContain('GET_ORDER_BOOK_DEPTH');
    });

    it('should successfully fetch multiple order books with multiple token IDs', async () => {
      const mockLLMResult = {
        tokenIds: ['123456', '789012'],
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getOrderBooks).mockResolvedValue(mockMultipleOrderBooks);

      const result = (await getOrderBookDepthAction.handler(
        mockRuntime,
        mockMessage,
        mockState
      )) as Content;

      expect(result).toBeDefined();
      expect(result.text).toContain('**Tokens Requested**: 2');
      expect(result.text).toContain('**Order Books Found**: 2');
      expect(result.text).toContain('**Token 1: `123456`**');
      expect(result.text).toContain('**Token 2: `789012`**');
      expect(result.text).toContain('Active Order Books: 2/2');
      expect(result.text).toContain('Total Bid Levels: 4');
      expect(result.text).toContain('Total Ask Levels: 4');
      expect((result.data as any)?.orderBooks).toEqual(mockMultipleOrderBooks);

      const expectedParams: BookParams[] = [{ token_id: '123456' }, { token_id: '789012' }];
      expect(mockClobClient.getOrderBooks).toHaveBeenCalledWith(expectedParams);
    });

    it('should handle fallback token ID extraction from query field', async () => {
      const mockLLMResult = {
        tokenIds: [],
        query: '123456 789012',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getOrderBooks).mockResolvedValue(mockMultipleOrderBooks);

      const result = (await getOrderBookDepthAction.handler(
        mockRuntime,
        mockMessage,
        mockState
      )) as Content;

      expect(mockClobClient.getOrderBooks).toHaveBeenCalledWith([
        { token_id: '123456' },
        { token_id: '789012' },
      ]);
      expect(result.text).toContain('📊 **Order Book Depth Summary**');
    });

    it('should handle empty order books gracefully', async () => {
      const emptyOrderBooks: OrderBook[] = [
        {
          market: '0x1234567890abcdef1234567890abcdef12345678901234567890abcdef12345678',
          asset_id: '123456',
          bids: [],
          asks: [],
        },
      ];

      const mockLLMResult = {
        tokenIds: ['123456'],
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getOrderBooks).mockResolvedValue(emptyOrderBooks);

      const result = (await getOrderBookDepthAction.handler(
        mockRuntime,
        mockMessage,
        mockState
      )) as Content;

      expect(result.text).toContain('Bid Levels: 0');
      expect(result.text).toContain('Ask Levels: 0');
      expect(result.text).toContain('Best Bid: No bids');
      expect(result.text).toContain('Best Ask: No asks');
      expect(result.text).toContain('Active Order Books: 0/1');
    });

    it('should handle mixed order books with some empty', async () => {
      const mixedOrderBooks: OrderBook[] = [
        mockSingleOrderBook,
        {
          market: '0x9876543210fedcba9876543210fedcba98765432109876543210fedcba98765432',
          asset_id: '789012',
          bids: [],
          asks: [],
        },
      ];

      const mockLLMResult = {
        tokenIds: ['123456', '789012'],
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getOrderBooks).mockResolvedValue(mixedOrderBooks);

      const result = (await getOrderBookDepthAction.handler(
        mockRuntime,
        mockMessage,
        mockState
      )) as Content;

      expect(result.text).toContain('Active Order Books: 1/2');
      expect(result.text).toContain('Total Bid Levels: 3');
      expect(result.text).toContain('Total Ask Levels: 3');
    });

    it('should throw error when CLOB_API_URL is not configured', async () => {
      vi.mocked(mockRuntime.getSetting).mockReturnValue(undefined);

      await expect(
        getOrderBookDepthAction.handler(mockRuntime, mockMessage, mockState)
      ).rejects.toThrow('CLOB_API_URL is required in configuration.');
    });

    it('should throw error when LLM returns error', async () => {
      const mockLLMResult = {
        error: 'No token IDs found',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);

      await expect(
        getOrderBookDepthAction.handler(mockRuntime, mockMessage, mockState)
      ).rejects.toThrow(
        'Token identifiers not found. Please specify one or more token IDs for order book depth.'
      );
    });

    it('should throw error when no valid token IDs are extracted', async () => {
      const mockLLMResult = {
        tokenIds: [],
        query: 'not-a-number',
      };

      const mockMessageWithoutToken = {
        ...mockMessage,
        content: { text: 'Show me order book depth without any token' },
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);

      await expect(
        getOrderBookDepthAction.handler(mockRuntime, mockMessageWithoutToken, mockState)
      ).rejects.toThrow(
        'Unable to extract token IDs from your message. Please provide valid token IDs.'
      );
    });

    it('should handle regex fallback extraction', async () => {
      const mockMessageWithTokens = {
        ...mockMessage,
        content: { text: 'ORDER_BOOK_DEPTH 123456 789012' },
      };

      vi.mocked(callLLMWithTimeout).mockRejectedValue(new Error('LLM timeout'));
      vi.mocked(mockClobClient.getOrderBooks).mockResolvedValue(mockMultipleOrderBooks);

      const result = (await getOrderBookDepthAction.handler(
        mockRuntime,
        mockMessageWithTokens,
        mockState
      )) as Content;

      expect(mockClobClient.getOrderBooks).toHaveBeenCalledWith([
        { token_id: '123456' },
        { token_id: '789012' },
      ]);
      expect(result.text).toContain('📊 **Order Book Depth Summary**');
    });

    it('should filter out invalid token IDs', async () => {
      const mockLLMResult = {
        tokenIds: ['123456', 'invalid', '789012', ''],
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getOrderBooks).mockResolvedValue(mockMultipleOrderBooks);

      const result = (await getOrderBookDepthAction.handler(
        mockRuntime,
        mockMessage,
        mockState
      )) as Content;

      expect(mockClobClient.getOrderBooks).toHaveBeenCalledWith([
        { token_id: '123456' },
        { token_id: '789012' },
      ]);
    });

    it('should throw error when no order books are found', async () => {
      const mockLLMResult = {
        tokenIds: ['123456'],
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getOrderBooks).mockResolvedValue([]);

      await expect(
        getOrderBookDepthAction.handler(mockRuntime, mockMessage, mockState)
      ).rejects.toThrow('No order books found for the provided token IDs: 123456');
    });

    it('should throw error when CLOB client getOrderBooks fails', async () => {
      const mockLLMResult = {
        tokenIds: ['123456'],
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getOrderBooks).mockRejectedValue(new Error('API Error'));

      await expect(
        getOrderBookDepthAction.handler(mockRuntime, mockMessage, mockState)
      ).rejects.toThrow('API Error');
    });

    it('should handle callback function properly on success', async () => {
      const mockCallback = vi.fn();
      const mockLLMResult = {
        tokenIds: ['123456'],
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getOrderBooks).mockResolvedValue([mockSingleOrderBook]);

      const result = await getOrderBookDepthAction.handler(
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
        error: 'No token IDs found',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);

      await expect(
        getOrderBookDepthAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow();

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('❌ **Error**'),
          actions: ['GET_ORDER_BOOK_DEPTH'],
          data: expect.objectContaining({ error: expect.any(String) }),
        })
      );
    });

    it('should include summary statistics in response data', async () => {
      const mockLLMResult = {
        tokenIds: ['123456', '789012'],
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getOrderBooks).mockResolvedValue(mockMultipleOrderBooks);

      const result = (await getOrderBookDepthAction.handler(
        mockRuntime,
        mockMessage,
        mockState
      )) as Content;

      const data = result.data as any;
      expect(data.summary).toBeDefined();
      expect(data.summary.tokensRequested).toBe(2);
      expect(data.summary.orderBooksFound).toBe(2);
      expect(data.summary.activeBooks).toBe(2);
      expect(data.summary.totalBids).toBe(4);
      expect(data.summary.totalAsks).toBe(4);
    });
  });

  describe('action metadata', () => {
    it('should have correct action name', () => {
      expect(getOrderBookDepthAction.name).toBe('GET_ORDER_BOOK_DEPTH');
    });

    it('should have appropriate similes', () => {
      expect(getOrderBookDepthAction.similes).toContain('ORDER_BOOK_DEPTH');
      expect(getOrderBookDepthAction.similes).toContain('BOOK_DEPTH');
      expect(getOrderBookDepthAction.similes).toContain('MULTIPLE_BOOKS');
      expect(getOrderBookDepthAction.similes).toContain('BULK_BOOKS');
    });

    it('should have meaningful description', () => {
      expect(getOrderBookDepthAction.description).toContain('Retrieve order book depth');
      expect(getOrderBookDepthAction.description).toContain('one or more');
      expect(getOrderBookDepthAction.description).toContain('Polymarket tokens');
    });

    it('should have proper examples', () => {
      expect(getOrderBookDepthAction.examples).toBeDefined();
      expect(Array.isArray(getOrderBookDepthAction.examples)).toBe(true);
      if (getOrderBookDepthAction.examples) {
        expect(getOrderBookDepthAction.examples.length).toBeGreaterThan(0);
      }
    });
  });
});
