import { getSimplifiedMarketsAction } from '../../src/actions/getSimplifiedMarkets';
import { initializeClobClient } from '../../src/utils/clobClient';
import { callLLMWithTimeout } from '../../src/utils/llmHelpers';
import type { IAgentRuntime, Memory, State, Content } from '@elizaos/core';
import type { SimplifiedMarket, SimplifiedMarketsResponse } from '../../src/types';

// Mock the dependencies
vi.mock('../../src/utils/clobClient');
vi.mock('../../src/utils/llmHelpers');

const mockInitializeClobClient = initializeClobClient as Mock;
const mockCallLLMWithTimeout = callLLMWithTimeout as Mock;

// Mock runtime object
const mockRuntime: Partial<IAgentRuntime> = {
  getSetting: vi.fn((key: string) => {
    if (key === 'CLOB_API_URL') return 'https://clob.polymarket.com';
    if (key === 'CLOB_API_KEY') return 'test-api-key';
    return undefined;
  }),
};

// Mock memory object
const mockMemory: Memory = {
  id: 'a1b2c3d4-e5f6-4a7b-8c9d-1e2f3a4b5c6d',
  entityId: 'a1b2c3d4-e5f6-4a7b-8c9d-1e2f3a4b5c6d',
  agentId: 'a1b2c3d4-e5f6-4a7b-8c9d-1e2f3a4b5c6e',
  roomId: 'a1b2c3d4-e5f6-4a7b-8c9d-1e2f3a4b5c6f',
  content: {
    text: 'Get simplified market data',
  },
  embedding: [0.1, 0.2, 0.3],
  createdAt: Date.now(),
};

// Mock state object
const mockState: State = {
  userId: 'test-user-id',
  agentId: 'a1b2c3d4-e5f6-4a7b-8c9d-1e2f3a4b5c6e',
  roomId: 'a1b2c3d4-e5f6-4a7b-8c9d-1e2f3a4b5c6f',
  agentName: 'test-agent',
  bio: 'test bio',
  lore: 'test lore',
  messageDirections: 'test directions',
  postDirections: 'test post directions',
  actors: 'test actors',
  actorsData: [],
  goals: 'test goals',
  goalsData: [],
  recentMessages: 'test recent messages',
  recentMessagesData: [],
  actionNames: 'test action names',
  actions: 'test actions',
  actionExamples: 'test action examples',
  providers: 'test providers',
  responseData: 'test response data',
  recentInteractionsData: [],
  recentInteractions: 'test recent interactions',
  formattedConversation: 'test formatted conversation',
  knowledge: 'test knowledge',
  knowledgeData: [],
  values: {},
  data: {},
  text: '',
  severity: 'info',
};

// Sample simplified market data for testing
const mockSimplifiedMarket: SimplifiedMarket = {
  condition_id: '0x1234567890abcdef1234567890abcdef12345678',
  tokens: [
    {
      token_id: '1234567890',
      outcome: 'Yes',
    },
    {
      token_id: '0987654321',
      outcome: 'No',
    },
  ],
  rewards: {
    min_size: 0.01,
    max_spread: 0.05,
    event_start_date: '2024-01-01T00:00:00Z',
    event_end_date: '2024-12-31T23:59:59Z',
    in_game_multiplier: 1.5,
    reward_epoch: 1,
  },
  min_incentive_size: '0.1',
  max_incentive_spread: '0.05',
  active: true,
  closed: false,
};

const mockSimplifiedMarketsResponse: SimplifiedMarketsResponse = {
  limit: 100,
  count: 1,
  next_cursor: 'LTE=',
  data: [mockSimplifiedMarket],
};

describe('getSimplifiedMarketsAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validation', () => {
    it('should validate successfully when CLOB_API_URL is provided', async () => {
      const result = await getSimplifiedMarketsAction.validate(
        mockRuntime as IAgentRuntime,
        mockMemory,
        mockState
      );

      expect(result).toBe(true);
      expect(mockRuntime.getSetting).toHaveBeenCalledWith('CLOB_API_URL');
    });

    it('should fail validation when CLOB_API_URL is not provided', async () => {
      const invalidRuntime = {
        ...mockRuntime,
        getSetting: vi.fn(() => undefined),
      };

      const result = await getSimplifiedMarketsAction.validate(
        invalidRuntime as IAgentRuntime,
        mockMemory,
        mockState
      );

      expect(result).toBe(false);
    });
  });

  describe('handler', () => {
    it('should successfully fetch simplified markets', async () => {
      // Mock the CLOB client
      const mockClient = {
        getSimplifiedMarkets: vi.fn().mockResolvedValue(mockSimplifiedMarketsResponse),
      };
      mockInitializeClobClient.mockResolvedValue(mockClient);

      // Mock LLM response for no pagination cursor
      mockCallLLMWithTimeout.mockResolvedValue({
        error: 'No pagination cursor requested. Fetching first page.',
      });

      const result = (await getSimplifiedMarketsAction.handler(
        mockRuntime as IAgentRuntime,
        mockMemory,
        mockState
      )) as Content;

      if (result) {
        expect(mockInitializeClobClient).toHaveBeenCalledWith(mockRuntime);
        expect(mockClient.getSimplifiedMarkets).toHaveBeenCalledWith('');
        expect(result.text).toContain('Retrieved 1 Simplified Polymarket markets');
        expect(result.text).toContain('Condition ID');
        expect(result.text).toContain(mockSimplifiedMarket.condition_id);
        expect(result.actions).toContain('GET_SIMPLIFIED_MARKETS');
        expect(result.data).toEqual({
          markets: [mockSimplifiedMarket],
          count: 1,
          total: 1,
          filtered: 0,
          next_cursor: 'LTE=',
          limit: 100,
        });
      }
    });

    it('should handle empty simplified markets response', async () => {
      const emptyResponse: SimplifiedMarketsResponse = {
        limit: 100,
        count: 0,
        next_cursor: 'LTE=',
        data: [],
      };

      const mockClient = {
        getSimplifiedMarkets: vi.fn().mockResolvedValue(emptyResponse),
      };
      mockInitializeClobClient.mockResolvedValue(mockClient);
      mockCallLLMWithTimeout.mockResolvedValue({
        error: 'No pagination cursor requested. Fetching first page.',
      });

      const result = (await getSimplifiedMarketsAction.handler(
        mockRuntime as IAgentRuntime,
        mockMemory,
        mockState
      )) as Content;

      if (result) {
        expect(result.text).toContain('Retrieved 0 Simplified Polymarket markets');
        expect(result.text).toContain('No valid simplified markets found');
        if (result.data) {
          expect((result.data as { count: number }).count).toBe(0);
        }
      }
    });

    it('should handle pagination cursor from LLM', async () => {
      const mockClient = {
        getSimplifiedMarkets: vi.fn().mockResolvedValue(mockSimplifiedMarketsResponse),
      };
      mockInitializeClobClient.mockResolvedValue(mockClient);

      // Mock LLM response with pagination cursor
      mockCallLLMWithTimeout.mockResolvedValue({
        next_cursor: 'test-cursor-123',
      });

      await getSimplifiedMarketsAction.handler(mockRuntime as IAgentRuntime, mockMemory, mockState);

      expect(mockClient.getSimplifiedMarkets).toHaveBeenCalledWith('test-cursor-123');
    });

    it('should handle CLOB client initialization error', async () => {
      const testError = new Error('Failed to initialize CLOB client');
      mockInitializeClobClient.mockRejectedValue(testError);

      await expect(
        getSimplifiedMarketsAction.handler(mockRuntime as IAgentRuntime, mockMemory, mockState)
      ).rejects.toThrow('Failed to initialize CLOB client');
    });

    it('should handle CLOB API error', async () => {
      const mockClient = {
        getSimplifiedMarkets: vi
          .fn()
          .mockRejectedValue(new Error('CLOB API error: 500 Internal Server Error')),
      };
      mockInitializeClobClient.mockResolvedValue(mockClient);
      mockCallLLMWithTimeout.mockResolvedValue({
        error: 'No pagination cursor requested. Fetching first page.',
      });

      await expect(
        getSimplifiedMarketsAction.handler(mockRuntime as IAgentRuntime, mockMemory, mockState)
      ).rejects.toThrow('CLOB API error: 500 Internal Server Error');
    });

    it('should handle invalid response from CLOB API', async () => {
      const mockClient = {
        getSimplifiedMarkets: vi.fn().mockResolvedValue(null),
      };
      mockInitializeClobClient.mockResolvedValue(mockClient);
      mockCallLLMWithTimeout.mockResolvedValue({
        error: 'No pagination cursor requested. Fetching first page.',
      });

      await expect(
        getSimplifiedMarketsAction.handler(mockRuntime as IAgentRuntime, mockMemory, mockState)
      ).rejects.toThrow('Invalid response from CLOB API');
    });

    it('should handle missing CLOB_API_URL', async () => {
      const invalidRuntime = {
        ...mockRuntime,
        getSetting: vi.fn(() => undefined),
      };

      await expect(
        getSimplifiedMarketsAction.handler(invalidRuntime as IAgentRuntime, mockMemory, mockState)
      ).rejects.toThrow('CLOB_API_URL is required in configuration.');
    });

    it('should handle callback if provided', async () => {
      const mockCallback = vi.fn();
      const mockClient = {
        getSimplifiedMarkets: vi.fn().mockResolvedValue(mockSimplifiedMarketsResponse),
      };
      mockInitializeClobClient.mockResolvedValue(mockClient);
      mockCallLLMWithTimeout.mockResolvedValue({
        error: 'No pagination cursor requested. Fetching first page.',
      });

      await getSimplifiedMarketsAction.handler(
        mockRuntime as IAgentRuntime,
        mockMemory,
        mockState,
        {},
        mockCallback
      );

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Retrieved 1 Simplified Polymarket markets'),
          actions: ['GET_SIMPLIFIED_MARKETS'],
        })
      );
    });

    it('should handle LLM timeout gracefully', async () => {
      const mockClient = {
        getSimplifiedMarkets: vi.fn().mockResolvedValue(mockSimplifiedMarketsResponse),
      };
      mockInitializeClobClient.mockResolvedValue(mockClient);

      // Mock LLM timeout
      mockCallLLMWithTimeout.mockRejectedValue(new Error('LLM timeout'));

      const result = (await getSimplifiedMarketsAction.handler(
        mockRuntime as IAgentRuntime,
        mockMemory,
        mockState
      )) as Content;

      // Should still work with default parameters
      expect(mockClient.getSimplifiedMarkets).toHaveBeenCalledWith('');
      expect(result.text).toContain('Retrieved 1 Simplified Polymarket markets');
    });
  });

  describe('action properties', () => {
    it('should have correct action name', () => {
      expect(getSimplifiedMarketsAction.name).toBe('GET_SIMPLIFIED_MARKETS');
    });

    it('should have appropriate similes', () => {
      expect(getSimplifiedMarketsAction.similes).toContain('LIST_SIMPLIFIED_MARKETS');
      expect(getSimplifiedMarketsAction.similes).toContain('SIMPLIFIED_MARKETS');
      expect(getSimplifiedMarketsAction.similes).toContain('SIMPLE_MARKETS');
    });

    it('should have correct description', () => {
      expect(getSimplifiedMarketsAction.description).toContain('simplified');
      expect(getSimplifiedMarketsAction.description).toContain('reduced schema');
    });

    it('should have usage examples', () => {
      expect(getSimplifiedMarketsAction.examples).toBeDefined();
      if (getSimplifiedMarketsAction.examples) {
        expect(getSimplifiedMarketsAction.examples.length).toBeGreaterThan(0);
      }
    });
  });
});
