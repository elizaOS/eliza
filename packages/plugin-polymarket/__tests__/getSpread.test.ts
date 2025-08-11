import { describe, it, expect, beforeEach, vi, type MockedFunction } from 'vitest';
import {
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  type Content,
} from '@elizaos/core';
import { getSpreadAction } from '../src/actions/getSpread';
import { initializeClobClient } from '../src/utils/clobClient';
import { callLLMWithTimeout } from '../src/utils/llmHelpers';

// Mock the dependencies
vi.mock('../src/utils/clobClient');
vi.mock('../src/utils/llmHelpers');

const mockInitializeClobClient = initializeClobClient as MockedFunction<
  typeof initializeClobClient
>;
const mockCallLLMWithTimeout = callLLMWithTimeout as MockedFunction<typeof callLLMWithTimeout>;

describe('getSpread Action', () => {
  let mockRuntime: IAgentRuntime;
  let mockMemory: Memory;
  let mockState: State;
  let mockCallback: HandlerCallback;

  beforeEach(() => {
    vi.clearAllMocks();

    mockRuntime = {
      getSetting: vi.fn().mockReturnValue('https://clob.polymarket.com'),
    } as unknown as IAgentRuntime;

    mockMemory = {
      id: 'test-memory-a1b2-c3d4-e5f6-g7h8-i9j0k1l2',
      entityId: 'test-entity-id',
      roomId: 'test-room-id',
      content: {
        text: 'Get spread for token 123456',
      },
    } as unknown as Memory;

    mockState = {} as State;

    mockCallback = vi.fn();
  });

  describe('Action Properties', () => {
    it('should have correct name', () => {
      expect(getSpreadAction.name).toBe('GET_SPREAD');
    });

    it('should have description', () => {
      expect(getSpreadAction.description).toBeDefined();
      expect(typeof getSpreadAction.description).toBe('string');
    });

    it('should have similes array', () => {
      expect(getSpreadAction.similes).toBeDefined();
      expect(Array.isArray(getSpreadAction.similes)).toBe(true);
      expect(getSpreadAction.similes?.length).toBeGreaterThan(0);
    });

    it('should have example conversations', () => {
      expect(getSpreadAction.examples).toBeDefined();
      expect(getSpreadAction.examples?.length).toBeGreaterThan(0);

      // Check that examples include expected action
      const firstExample = getSpreadAction.examples?.[0];
      const elizaResponse = firstExample?.[1];
      expect(elizaResponse?.content.actions).toContain('GET_SPREAD');
    });

    it('should have validate function', () => {
      expect(getSpreadAction.validate).toBeDefined();
      expect(typeof getSpreadAction.validate).toBe('function');
    });

    it('should have handler function', () => {
      expect(getSpreadAction.handler).toBeDefined();
      expect(typeof getSpreadAction.handler).toBe('function');
    });
  });

  describe('Handler Function', () => {
    it('should successfully get spread when valid token ID provided', async () => {
      const mockClient = {
        getSpread: vi.fn().mockResolvedValue({
          spread: '0.0450',
        }),
      };

      mockInitializeClobClient.mockResolvedValue(mockClient as any);
      mockCallLLMWithTimeout.mockResolvedValue({
        tokenId: '123456',
      });

      const result = (await getSpreadAction.handler(
        mockRuntime,
        mockMemory,
        mockState,
        {},
        mockCallback
      )) as Content;

      expect(result).toBeDefined();
      expect(result.text).toContain('Spread for Token 123456');
      expect(result.text).toContain('0.0450');
      expect(result.text).toContain('4.50%');
      expect(result.actions).toContain('GET_SPREAD');
      expect((result.data as any).tokenId).toBe('123456');
      expect((result.data as any).spread).toBe('0.0450');
      expect((result.data as any).formattedSpread).toBe('0.0450');
      expect((result.data as any).percentageSpread).toBe('4.50');
      expect(mockCallback).toHaveBeenCalledWith(result);
    });

    it('should handle LLM extraction failure with regex fallback', async () => {
      const mockClient = {
        getSpread: vi.fn().mockResolvedValue({
          spread: '0.0275',
        }),
      };

      mockInitializeClobClient.mockResolvedValue(mockClient as any);
      mockCallLLMWithTimeout.mockRejectedValue(new Error('LLM timeout'));

      mockMemory.content!.text = 'What is the spread for 789012?';

      const result = (await getSpreadAction.handler(
        mockRuntime,
        mockMemory,
        mockState,
        {},
        mockCallback
      )) as Content;

      expect(result).toBeDefined();
      expect(result.text).toContain('Spread for Token 789012');
      expect((result.data as any).tokenId).toBe('789012');
      expect((result.data as any).spread).toBe('0.0275');
    });

    it('should handle missing token ID gracefully', async () => {
      mockCallLLMWithTimeout.mockResolvedValue({
        error: 'Token ID not found',
      });

      mockMemory.content!.text = 'Get spread for something';

      try {
        await getSpreadAction.handler(mockRuntime, mockMemory, mockState, {}, mockCallback);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(mockCallback).toHaveBeenCalledWith(
          expect.objectContaining({
            text: expect.stringContaining('Please provide a token ID'),
            actions: ['GET_SPREAD'],
          })
        );
      }
    });

    it('should handle CLOB client errors', async () => {
      const mockClient = {
        getSpread: vi.fn().mockRejectedValue(new Error('CLOB API error: 404 Not Found')),
      };

      mockInitializeClobClient.mockResolvedValue(mockClient as any);
      mockCallLLMWithTimeout.mockResolvedValue({
        tokenId: '999999',
      });

      try {
        await getSpreadAction.handler(mockRuntime, mockMemory, mockState, {}, mockCallback);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(mockCallback).toHaveBeenCalledWith(
          expect.objectContaining({
            text: expect.stringContaining('Error getting spread'),
            actions: ['GET_SPREAD'],
          })
        );
      }
    });

    it('should handle invalid spread response', async () => {
      const mockClient = {
        getSpread: vi.fn().mockResolvedValue({
          spread: null,
        }),
      };

      mockInitializeClobClient.mockResolvedValue(mockClient as any);
      mockCallLLMWithTimeout.mockResolvedValue({
        tokenId: '123456',
      });

      try {
        await getSpreadAction.handler(mockRuntime, mockMemory, mockState, {}, mockCallback);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    });

    it('should format spread values correctly', async () => {
      const testCases = [
        { input: '0.1250', expectedFormatted: '0.1250', expectedPercentage: '12.50' },
        { input: '0.0050', expectedFormatted: '0.0050', expectedPercentage: '0.50' },
        { input: '0.9999', expectedFormatted: '0.9999', expectedPercentage: '99.99' },
      ];

      for (const testCase of testCases) {
        const mockClient = {
          getSpread: vi.fn().mockResolvedValue({
            spread: testCase.input,
          }),
        };

        mockInitializeClobClient.mockResolvedValue(mockClient as any);
        mockCallLLMWithTimeout.mockResolvedValue({
          tokenId: '123456',
        });

        const result = (await getSpreadAction.handler(
          mockRuntime,
          mockMemory,
          mockState,
          {},
          mockCallback
        )) as Content;

        expect((result.data as any).formattedSpread).toBe(testCase.expectedFormatted);
        expect((result.data as any).percentageSpread).toBe(testCase.expectedPercentage);
      }
    });

    it('should include timestamp in response data', async () => {
      const mockClient = {
        getSpread: vi.fn().mockResolvedValue({
          spread: '0.0450',
        }),
      };

      mockInitializeClobClient.mockResolvedValue(mockClient as any);
      mockCallLLMWithTimeout.mockResolvedValue({
        tokenId: '123456',
      });

      const result = (await getSpreadAction.handler(
        mockRuntime,
        mockMemory,
        mockState,
        {},
        mockCallback
      )) as Content;

      expect((result.data as any).timestamp).toBeDefined();
      expect(typeof (result.data as any).timestamp).toBe('string');
      expect(new Date((result.data as any).timestamp)).toBeInstanceOf(Date);
    });
  });

  describe('Validation Function', () => {
    it('should validate successfully', async () => {
      const result = await getSpreadAction.validate(mockRuntime, mockMemory);
      expect(result).toBe(true);
    });
  });

  describe('Similes', () => {
    it('should include common spread-related terms', () => {
      const expectedSimiles = ['SPREAD', 'GET_SPREAD', 'BID_ASK_SPREAD', 'MARKET_SPREAD'];

      expectedSimiles.forEach((simile) => {
        expect(getSpreadAction.similes).toContain(simile);
      });
    });
  });

  describe('Examples', () => {
    it('should have multiple example conversations', () => {
      expect(getSpreadAction.examples?.length).toBeGreaterThanOrEqual(3);
    });

    it('should have valid example structure', () => {
      getSpreadAction.examples?.forEach((example) => {
        expect(Array.isArray(example)).toBe(true);
        expect(example.length).toBe(2);

        const [userMessage, agentMessage] = example;
        expect(userMessage.name).toBeDefined();
        expect(userMessage.content.text).toBeDefined();
        expect(agentMessage.name).toBeDefined();
        expect(agentMessage.content.text).toBeDefined();
        expect(agentMessage.content.actions).toContain('GET_SPREAD');
      });
    });
  });
});
