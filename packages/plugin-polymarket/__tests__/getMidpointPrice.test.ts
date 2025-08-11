import { describe, it, expect, beforeEach, vi, type MockedFunction } from 'vitest';
import {
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  type Content,
} from '@elizaos/core';
import { getMidpointPriceAction } from '../src/actions/getMidpointPrice';
import { initializeClobClient } from '../src/utils/clobClient';
import { callLLMWithTimeout } from '../src/utils/llmHelpers';

// Mock the dependencies
vi.mock('../src/utils/clobClient');
vi.mock('../src/utils/llmHelpers');

const mockInitializeClobClient = initializeClobClient as MockedFunction<
  typeof initializeClobClient
>;
const mockCallLLMWithTimeout = callLLMWithTimeout as MockedFunction<typeof callLLMWithTimeout>;

describe('getMidpointPrice Action', () => {
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
        text: 'Get midpoint price for token 123456',
      },
    } as Memory;

    // Setup mock state
    mockState = {} as State;

    // Setup mock callback
    mockCallback = vi.fn();

    // Setup mock CLOB client
    mockClobClient = {
      getMidpoint: vi.fn(),
    };

    mockInitializeClobClient.mockResolvedValue(mockClobClient);
  });

  describe('validate', () => {
    it('should return false when CLOB_API_URL is not provided', async () => {
      const mockRuntimeNoUrl = {
        getSetting: vi.fn(() => undefined),
      } as any;

      const result = await getMidpointPriceAction.validate(mockRuntimeNoUrl, mockMemory, mockState);
      expect(result).toBe(false);
    });

    it('should return true when CLOB_API_URL is provided', async () => {
      const result = await getMidpointPriceAction.validate(mockRuntime, mockMemory, mockState);
      expect(result).toBe(true);
    });

    it('should return true for various midpoint-related messages', async () => {
      const testCases = [
        'Get midpoint price for token 123456',
        'What is the midpoint for this token?',
        'Show me the mid price',
        'MIDPOINT_PRICE token 456789',
        'Get the middle price for market 789012',
      ];

      for (const text of testCases) {
        const memory = { content: { text } } as Memory;
        const result = await getMidpointPriceAction.validate(mockRuntime, memory, mockState);
        expect(result).toBe(true);
      }
    });
  });

  describe('handler', () => {
    it('should successfully get midpoint price using LLM extraction', async () => {
      // Setup LLM to return valid parameters
      mockCallLLMWithTimeout.mockResolvedValue({
        tokenId: '123456',
      });

      // Setup CLOB client to return midpoint price
      mockClobClient.getMidpoint.mockResolvedValue({
        mid: '0.5500',
      });

      const result = (await getMidpointPriceAction.handler(
        mockRuntime,
        mockMemory,
        mockState,
        {},
        mockCallback
      )) as Content;

      expect(result).toBeDefined();
      expect(result.text).toContain('Midpoint Price for Token 123456');
      expect(result.text).toContain('$0.5500 (55.00%)');
      expect(result.text).toContain('halfway point between the best bid and best ask');
      expect((result.data as any).tokenId).toBe('123456');
      expect((result.data as any).midpoint).toBe('0.5500');
      expect((result.data as any).formattedPrice).toBe('0.5500');
      expect((result.data as any).percentagePrice).toBe('55.00');
      expect(mockCallback).toHaveBeenCalledWith(result);
    });

    it('should fallback to regex extraction when LLM fails', async () => {
      // Setup LLM to fail
      mockCallLLMWithTimeout.mockRejectedValue(new Error('LLM failed'));

      // Setup CLOB client to return midpoint price
      mockClobClient.getMidpoint.mockResolvedValue({
        mid: '0.3250',
      });

      // Setup memory with regex-extractable content
      const memory = {
        content: { text: 'Show me the midpoint for token 789012' },
      } as Memory;

      const result = (await getMidpointPriceAction.handler(
        mockRuntime,
        memory,
        mockState,
        {},
        mockCallback
      )) as Content;

      expect(result).toBeDefined();
      expect(result.text).toContain('Midpoint Price for Token 789012');
      expect(result.text).toContain('$0.3250 (32.50%)');
      expect((result.data as any).tokenId).toBe('789012');
      expect((result.data as any).midpoint).toBe('0.3250');
    });

    it('should handle various token ID extraction patterns', async () => {
      const testCases = [
        { input: 'midpoint for token 123456', expectedTokenId: '123456' },
        { input: 'get midpoint for market 789012', expectedTokenId: '789012' },
        { input: 'midpoint price for id 456789', expectedTokenId: '456789' },
        { input: 'show midpoint 999999', expectedTokenId: '999999' },
      ];

      for (const testCase of testCases) {
        vi.clearAllMocks();
        mockCallLLMWithTimeout.mockRejectedValue(new Error('LLM failed'));
        mockClobClient.getMidpoint.mockResolvedValue({ mid: '0.5000' });

        const memory = { content: { text: testCase.input } } as Memory;

        const result = (await getMidpointPriceAction.handler(
          mockRuntime,
          memory,
          mockState,
          {},
          mockCallback
        )) as Content;

        expect((result.data as any).tokenId).toBe(testCase.expectedTokenId);
      }
    });

    it('should throw error when no token ID is found', async () => {
      mockCallLLMWithTimeout.mockRejectedValue(new Error('LLM failed'));

      const memory = { content: { text: 'get me some midpoint data' } } as Memory;

      await expect(
        getMidpointPriceAction.handler(mockRuntime, memory, mockState, {}, mockCallback)
      ).rejects.toThrow('Please provide a token ID to get the midpoint price for.');

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
        getMidpointPriceAction.handler(mockRuntimeNoUrl, mockMemory, mockState, {}, mockCallback)
      ).rejects.toThrow('CLOB_API_URL is required in configuration.');
    });

    it('should handle CLOB client errors gracefully', async () => {
      mockCallLLMWithTimeout.mockResolvedValue({
        tokenId: '123456',
      });

      mockClobClient.getMidpoint.mockRejectedValue(new Error('Network error'));

      await expect(
        getMidpointPriceAction.handler(mockRuntime, mockMemory, mockState, {}, mockCallback)
      ).rejects.toThrow('Network error');

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Error getting midpoint price'),
        })
      );
    });

    it('should handle invalid midpoint response', async () => {
      mockCallLLMWithTimeout.mockResolvedValue({
        tokenId: '123456',
      });

      // Mock empty/invalid response
      mockClobClient.getMidpoint.mockResolvedValue({});

      await expect(
        getMidpointPriceAction.handler(mockRuntime, mockMemory, mockState, {}, mockCallback)
      ).rejects.toThrow('No midpoint price data available for token 123456');
    });

    it('should handle null midpoint response', async () => {
      mockCallLLMWithTimeout.mockResolvedValue({
        tokenId: '123456',
      });

      // Mock null response
      mockClobClient.getMidpoint.mockResolvedValue(null);

      await expect(
        getMidpointPriceAction.handler(mockRuntime, mockMemory, mockState, {}, mockCallback)
      ).rejects.toThrow('No midpoint price data available for token 123456');
    });

    it('should format price correctly for various values', async () => {
      const testCases = [
        { midpoint: '0.1234', expectedFormatted: '0.1234', expectedPercentage: '12.34' },
        { midpoint: '0.9876', expectedFormatted: '0.9876', expectedPercentage: '98.76' },
        { midpoint: '0.0001', expectedFormatted: '0.0001', expectedPercentage: '0.01' },
        { midpoint: '1.0000', expectedFormatted: '1.0000', expectedPercentage: '100.00' },
      ];

      for (const testCase of testCases) {
        vi.clearAllMocks();
        mockCallLLMWithTimeout.mockResolvedValue({ tokenId: '123456' });
        mockClobClient.getMidpoint.mockResolvedValue({ mid: testCase.midpoint });

        const result = (await getMidpointPriceAction.handler(
          mockRuntime,
          mockMemory,
          mockState,
          {},
          mockCallback
        )) as Content;

        expect((result.data as any).formattedPrice).toBe(testCase.expectedFormatted);
        expect((result.data as any).percentagePrice).toBe(testCase.expectedPercentage);
        expect(result.text).toContain(`$${testCase.expectedFormatted}`);
        expect(result.text).toContain(`${testCase.expectedPercentage}%`);
      }
    });

    it('should include correct action in response', async () => {
      mockCallLLMWithTimeout.mockResolvedValue({
        tokenId: '123456',
      });

      mockClobClient.getMidpoint.mockResolvedValue({
        mid: '0.5500',
      });

      const result = (await getMidpointPriceAction.handler(
        mockRuntime,
        mockMemory,
        mockState,
        {},
        mockCallback
      )) as Content;

      expect(result.actions).toContain('GET_MIDPOINT_PRICE');
    });

    it('should include timestamp in response data', async () => {
      mockCallLLMWithTimeout.mockResolvedValue({
        tokenId: '123456',
      });

      mockClobClient.getMidpoint.mockResolvedValue({
        mid: '0.5500',
      });

      const result = (await getMidpointPriceAction.handler(
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

    it('should handle LLM returning error flag', async () => {
      mockCallLLMWithTimeout.mockResolvedValue({
        error: 'Token ID not found',
      });

      const memory = { content: { text: 'midpoint for some random text' } } as Memory;

      await expect(
        getMidpointPriceAction.handler(mockRuntime, memory, mockState, {}, mockCallback)
      ).rejects.toThrow('Please provide a token ID to get the midpoint price for.');
    });
  });

  describe('action properties', () => {
    it('should have correct name', () => {
      expect(getMidpointPriceAction.name).toBe('GET_MIDPOINT_PRICE');
    });

    it('should have appropriate similes', () => {
      const similes = getMidpointPriceAction.similes;
      expect(similes).toContain('MIDPOINT_PRICE');
      expect(similes).toContain('GET_MIDPOINT');
      expect(similes).toContain('MID_PRICE');
      expect(similes).toContain('MIDDLE_PRICE');
    });

    it('should have descriptive description', () => {
      expect(getMidpointPriceAction.description).toContain('midpoint price');
      expect(getMidpointPriceAction.description).toContain('halfway between best bid and best ask');
    });

    it('should have example conversations', () => {
      expect(getMidpointPriceAction.examples).toBeDefined();
      expect(getMidpointPriceAction.examples?.length).toBeGreaterThan(0);

      // Check that examples include expected action
      const firstExample = getMidpointPriceAction.examples?.[0];
      const elizaResponse = firstExample?.[1];
      expect(elizaResponse?.content.actions).toContain('GET_MIDPOINT_PRICE');
    });
  });
});
