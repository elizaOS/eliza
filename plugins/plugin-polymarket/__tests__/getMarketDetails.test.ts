import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IAgentRuntime, Memory, State, Content } from '@elizaos/core';
import { getMarketDetailsAction } from '../src/actions/getMarketDetails';
import { initializeClobClient } from '../src/utils/clobClient';
import { callLLMWithTimeout } from '../src/utils/llmHelpers';
import type { Market } from '../src/types';

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

describe('getMarketDetailsAction', () => {
  let mockRuntime: IAgentRuntime;
  let mockMessage: Memory;
  let mockState: State;
  let mockClobClient: any;

  const mockMarket: Market = {
    condition_id: '0x1234567890abcdef1234567890abcdef12345678901234567890abcdef12345678',
    question_id: 'test-question-id',
    question: 'Will Bitcoin reach $100,000 by end of 2024?',
    category: 'crypto',
    market_slug: 'bitcoin-100k-2024',
    active: true,
    closed: false,
    end_date_iso: '2024-12-31T23:59:59Z',
    game_start_time: '2024-01-01T00:00:00Z',
    minimum_order_size: '0.1',
    minimum_tick_size: '0.01',
    min_incentive_size: '1.0',
    max_incentive_spread: '0.05',
    seconds_delay: 30,
    icon: 'bitcoin-icon.png',
    fpmm: '0xabc123def456789abc123def456789abc123def45',
    tokens: [
      {
        token_id: '123456',
        outcome: 'Yes',
      },
      {
        token_id: '123457',
        outcome: 'No',
      },
    ],
    rewards: {
      min_size: 1.0,
      max_spread: 0.1,
      event_start_date: '2024-01-01',
      event_end_date: '2024-12-31',
      in_game_multiplier: 2.5,
      reward_epoch: 1,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockRuntime = {
      getSetting: vi.fn(),
    } as unknown as IAgentRuntime;

    mockMessage = {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' as `${string}-${string}-${string}-${string}-${string}`,
      content: {
        text: 'Show me market 0x1234567890abcdef1234567890abcdef12345678901234567890abcdef12345678',
      },
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
      getMarket: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('validate', () => {
    it('should return true when CLOB_API_URL is provided', async () => {
      vi.mocked(mockRuntime.getSetting).mockReturnValue('https://clob.polymarket.com');

      const result = await getMarketDetailsAction.validate(mockRuntime, mockMessage, mockState);

      expect(result).toBe(true);
      expect(mockRuntime.getSetting).toHaveBeenCalledWith('CLOB_API_URL');
    });

    it('should return false when CLOB_API_URL is not provided', async () => {
      vi.mocked(mockRuntime.getSetting).mockReturnValue(undefined);

      const result = await getMarketDetailsAction.validate(mockRuntime, mockMessage, mockState);

      expect(result).toBe(false);
      expect(mockRuntime.getSetting).toHaveBeenCalledWith('CLOB_API_URL');
    });
  });

  describe('handler', () => {
    beforeEach(() => {
      vi.mocked(mockRuntime.getSetting).mockReturnValue('https://clob.polymarket.com');
      vi.mocked(initializeClobClient).mockResolvedValue(mockClobClient);
    });

    it('should successfully fetch market details with valid condition ID', async () => {
      const mockLLMResult = {
        marketId: '0x1234567890abcdef1234567890abcdef12345678901234567890abcdef12345678',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getMarket).mockResolvedValue(mockMarket);

      const result = (await getMarketDetailsAction.handler(
        mockRuntime,
        mockMessage,
        mockState
      )) as Content;

      expect(result).toBeDefined();
      expect(result.text).toContain('📊 **Market Details**');
      expect(result.text).toContain('Will Bitcoin reach $100,000 by end of 2024?');
      expect(result.text).toContain(
        '0x1234567890abcdef1234567890abcdef12345678901234567890abcdef12345678'
      );
      expect(result.text).toContain('Active: ✅');
      expect(result.text).toContain('Closed: ❌');
      expect(result.text).toContain('Category: crypto');
      expect((result.data as any)?.market).toEqual(mockMarket);
      expect(result.actions).toContain('GET_MARKET_DETAILS');
    });

    it('should handle fallback ID extraction from query field', async () => {
      const mockLLMResult = {
        marketId: '',
        query: 'invalid-short-id',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);

      await expect(
        getMarketDetailsAction.handler(mockRuntime, mockMessage, mockState)
      ).rejects.toThrow(
        'Unable to extract market condition ID from your message. Please provide a valid condition ID.'
      );
    });

    it('should handle fallback ID extraction from tokenId field', async () => {
      const mockLLMResult = {
        marketId: '',
        query: '',
        tokenId: 'not-a-hex-string',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);

      await expect(
        getMarketDetailsAction.handler(mockRuntime, mockMessage, mockState)
      ).rejects.toThrow(
        'Unable to extract market condition ID from your message. Please provide a valid condition ID.'
      );
    });

    it('should display all available market sections when data is present', async () => {
      const mockLLMResult = {
        marketId: '0x1234567890abcdef1234567890abcdef12345678901234567890abcdef12345678',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getMarket).mockResolvedValue(mockMarket);

      const result = (await getMarketDetailsAction.handler(
        mockRuntime,
        mockMessage,
        mockState
      )) as Content;

      expect(result.text).toContain('**Market Information:**');
      expect(result.text).toContain('**Trading Details:**');
      expect(result.text).toContain('**Outcome Tokens:**');
      expect(result.text).toContain('**Rewards Information:**');
      expect(result.text).toContain('**Contract Information:**');
      expect(result.text).toContain('End Date: 1/1/2025');
      expect(result.text).toContain('Game Start: 1/1/2024');
      expect(result.text).toContain('Match Delay: 30 seconds');
    });

    it('should handle market with minimal data gracefully', async () => {
      const minimalMarket: Market = {
        condition_id: '0x1234567890abcdef1234567890abcdef12345678901234567890abcdef12345678',
        question_id: 'minimal-question-id',
        question: 'Simple market question',
        category: 'test',
        market_slug: 'test-market',
        minimum_order_size: '0.1',
        minimum_tick_size: '0.01',
        min_incentive_size: '1.0',
        max_incentive_spread: '0.05',
        end_date_iso: '2024-12-31T23:59:59Z',
        game_start_time: '2024-01-01T00:00:00Z',
        active: false,
        closed: true,
        seconds_delay: 0,
        icon: '',
        fpmm: '',
        tokens: [
          { token_id: '1', outcome: 'Yes' },
          { token_id: '2', outcome: 'No' },
        ],
        rewards: {
          min_size: 1.0,
          max_spread: 0.1,
          event_start_date: '2024-01-01',
          event_end_date: '2024-12-31',
          in_game_multiplier: 1.0,
          reward_epoch: 1,
        },
      };

      const mockLLMResult = {
        marketId: '0x1234567890abcdef1234567890abcdef12345678901234567890abcdef12345678',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getMarket).mockResolvedValue(minimalMarket);

      const result = (await getMarketDetailsAction.handler(
        mockRuntime,
        mockMessage,
        mockState
      )) as Content;

      expect(result.text).toContain('Simple market question');
      expect(result.text).toContain('Active: ❌');
      expect(result.text).toContain('Closed: ✅');
    });

    it('should throw error when CLOB_API_URL is not configured', async () => {
      vi.mocked(mockRuntime.getSetting).mockReturnValue(undefined);

      await expect(
        getMarketDetailsAction.handler(mockRuntime, mockMessage, mockState)
      ).rejects.toThrow('CLOB_API_URL is required in configuration.');
    });

    it('should throw error when LLM returns error', async () => {
      const mockLLMResult = {
        error: 'No market ID found',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);

      await expect(
        getMarketDetailsAction.handler(mockRuntime, mockMessage, mockState)
      ).rejects.toThrow(
        'Unable to extract market condition ID from your message. Please provide a valid condition ID.'
      );
    });

    it('should throw error when no valid condition ID is extracted', async () => {
      const mockLLMResult = {
        marketId: '',
        query: 'invalid-id',
        tokenId: '123',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);

      await expect(
        getMarketDetailsAction.handler(mockRuntime, mockMessage, mockState)
      ).rejects.toThrow(
        'Unable to extract market condition ID from your message. Please provide a valid condition ID.'
      );
    });

    it('should throw error when LLM call fails', async () => {
      vi.mocked(callLLMWithTimeout).mockRejectedValue(new Error('LLM timeout'));

      await expect(
        getMarketDetailsAction.handler(mockRuntime, mockMessage, mockState)
      ).rejects.toThrow(
        'Unable to extract market condition ID from your message. Please provide a valid condition ID.'
      );
    });

    it('should throw error when market is not found', async () => {
      const mockLLMResult = {
        marketId: '0x1234567890abcdef1234567890abcdef12345678901234567890abcdef12345678',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getMarket).mockResolvedValue(null);

      await expect(
        getMarketDetailsAction.handler(mockRuntime, mockMessage, mockState)
      ).rejects.toThrow(
        'Market not found for condition ID: 0x1234567890abcdef1234567890abcdef12345678901234567890abcdef12345678'
      );
    });

    it('should throw error when CLOB client getMarket fails', async () => {
      const mockLLMResult = {
        marketId: '0x1234567890abcdef1234567890abcdef12345678901234567890abcdef12345678',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getMarket).mockRejectedValue(new Error('API Error'));

      await expect(
        getMarketDetailsAction.handler(mockRuntime, mockMessage, mockState)
      ).rejects.toThrow('API Error');
    });

    it('should handle callback function properly on success', async () => {
      const mockCallback = vi.fn();
      const mockLLMResult = {
        marketId: '0x1234567890abcdef1234567890abcdef12345678901234567890abcdef12345678',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getMarket).mockResolvedValue(mockMarket);

      const result = await getMarketDetailsAction.handler(
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
        error: 'No market ID found',
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);

      await expect(
        getMarketDetailsAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow();

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('❌ **Error**'),
          actions: ['GET_MARKET_DETAILS'],
          data: expect.objectContaining({ error: expect.any(String) }),
        })
      );
    });

    it('should validate hex pattern for condition ID correctly', async () => {
      const validTestCase = {
        id: '0x1234567890abcdef1234567890abcdef12345678901234567890abcdef12345678',
        valid: true,
      };

      const mockLLMResult = {
        marketId: validTestCase.id,
      };

      vi.mocked(callLLMWithTimeout).mockResolvedValue(mockLLMResult);
      vi.mocked(mockClobClient.getMarket).mockResolvedValue(mockMarket);

      const result = (await getMarketDetailsAction.handler(
        mockRuntime,
        mockMessage,
        mockState
      )) as Content;
      expect(result.text).toContain('📊 **Market Details**');

      const invalidCases = [
        '0x123',
        'not-hex',
        '1234567890abcdef1234567890abcdef12345678901234567890abcdef12345678',
      ];

      for (const invalidId of invalidCases) {
        const invalidMockResult = {
          marketId: '',
          query: invalidId,
        };

        vi.mocked(callLLMWithTimeout).mockResolvedValue(invalidMockResult);

        await expect(
          getMarketDetailsAction.handler(mockRuntime, mockMessage, mockState)
        ).rejects.toThrow();
      }
    });
  });

  describe('action metadata', () => {
    it('should have correct action name', () => {
      expect(getMarketDetailsAction.name).toBe('GET_MARKET_DETAILS');
    });

    it('should have appropriate similes', () => {
      expect(getMarketDetailsAction.similes).toContain('GET_MARKET');
      expect(getMarketDetailsAction.similes).toContain('MARKET_DETAILS');
      expect(getMarketDetailsAction.similes).toContain('SHOW_MARKET');
      expect(getMarketDetailsAction.similes).toContain('FETCH_MARKET');
      expect(getMarketDetailsAction.similes).toContain('MARKET_INFO');
    });

    it('should have meaningful description', () => {
      expect(getMarketDetailsAction.description).toContain('Retrieve detailed information');
      expect(getMarketDetailsAction.description).toContain('Polymarket prediction market');
      expect(getMarketDetailsAction.description).toContain('condition ID');
    });

    it('should have proper examples', () => {
      expect(getMarketDetailsAction.examples).toBeDefined();
      expect(Array.isArray(getMarketDetailsAction.examples)).toBe(true);
      if (getMarketDetailsAction.examples) {
        expect(getMarketDetailsAction.examples.length).toBeGreaterThan(0);
      }
    });
  });
});
