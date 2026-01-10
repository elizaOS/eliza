import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import { getPriceHistory } from '../src/actions/getPriceHistory';
import { initializeClobClient, type PricePoint } from '../src/utils/clobClient';
import { callLLMWithTimeout } from '../src/utils/llmHelpers';

// Mock the dependencies
vi.mock('../src/utils/clobClient');
vi.mock('../src/utils/llmHelpers');

const mockInitializeClobClient = vi.mocked(initializeClobClient);
const mockCallLLMWithTimeout = vi.mocked(callLLMWithTimeout);

describe('getPriceHistory Action', () => {
  let mockRuntime: IAgentRuntime;
  let mockMessage: Memory;
  let mockState: State;
  let mockCallback: vi.Mock;
  let mockClobClient: any;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Mock runtime
    mockRuntime = {
      getSetting: vi.fn(),
      agentId: 'test-agent',
      serverUrl: 'http://localhost:3000',
      token: 'test-token',
    } as any;

    // Mock message
    mockMessage = {
      id: '123e4567-e89b-12d3-a456-426614174000' as `${string}-${string}-${string}-${string}-${string}`,
      content: { text: 'Get price history for token 123456 with 1d interval' },
      roomId:
        '123e4567-e89b-12d3-a456-426614174001' as `${string}-${string}-${string}-${string}-${string}`,
      entityId:
        '123e4567-e89b-12d3-a456-426614174002' as `${string}-${string}-${string}-${string}-${string}`,
    } as Memory;

    // Mock state
    mockState = {} as State;

    // Mock callback
    mockCallback = vi.fn();

    // Mock CLOB client
    mockClobClient = {
      getPricesHistory: vi.fn(),
    };

    mockInitializeClobClient.mockResolvedValue(mockClobClient);
  });

  describe('Action Properties', () => {
    it('should have correct name', () => {
      expect(getPriceHistory.name).toBe('GET_PRICE_HISTORY');
    });

    it('should have price history related similes', () => {
      expect(getPriceHistory.similes).toContain('PRICE_HISTORY');
      expect(getPriceHistory.similes).toContain('GET_PRICE_HISTORY');
      expect(getPriceHistory.similes).toContain('HISTORICAL_PRICES');
      expect(getPriceHistory.similes).toContain('PRICE_CHART');
    });

    it('should have appropriate description', () => {
      expect(getPriceHistory.description).toContain('historical price data');
      expect(getPriceHistory.description).toContain('time-series');
    });
  });

  describe('Successful Price History Retrieval', () => {
    it('should retrieve and format price history correctly', async () => {
      const mockPriceHistory: PricePoint[] = [
        { t: 1640995200, p: 0.6523 }, // 2022-01-01 12:00:00
        { t: 1640908800, p: 0.6445 }, // 2021-12-31 12:00:00
        { t: 1640822400, p: 0.6387 }, // 2021-12-30 12:00:00
      ];

      mockClobClient.getPricesHistory.mockResolvedValue(mockPriceHistory);
      mockCallLLMWithTimeout.mockResolvedValue({
        tokenId: '123456',
        interval: '1d',
      });

      const result = await getPriceHistory.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(true);
      expect(mockClobClient.getPricesHistory).toHaveBeenCalledWith('123456', '1d');

      const callArgs = mockCallback.mock.calls[0][0];
      expect(callArgs.text).toContain('📈 **Price History for Token 123456**');
      expect(callArgs.text).toContain('⏱️ **Interval**: 1d');
      expect(callArgs.text).toContain('📊 **Data Points**: 3');
      expect(callArgs.content.action).toBe('price_history_retrieved');
      expect(callArgs.content.tokenId).toBe('123456');
      expect(callArgs.content.interval).toBe('1d');
      expect(callArgs.content.pointsCount).toBe(3);
    });

    it('should handle empty price history', async () => {
      mockClobClient.getPricesHistory.mockResolvedValue([]);
      mockCallLLMWithTimeout.mockResolvedValue({
        tokenId: '123456',
        interval: '1d',
      });

      const result = await getPriceHistory.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(true);
      const callArgs = mockCallback.mock.calls[0][0];
      expect(callArgs.text).toContain('📈 **No price history found for Token 123456**');
      expect(callArgs.text).toContain('No historical price data is available');
    });

    it('should use default interval when not specified', async () => {
      const mockPriceHistory: PricePoint[] = [{ t: 1640995200, p: 0.6523 }];

      mockClobClient.getPricesHistory.mockResolvedValue(mockPriceHistory);
      mockCallLLMWithTimeout.mockResolvedValue({
        tokenId: '123456',
        // No interval specified
      });

      const result = await getPriceHistory.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(true);
      expect(mockClobClient.getPricesHistory).toHaveBeenCalledWith('123456', '1d');

      const callArgs = mockCallback.mock.calls[0][0];
      expect(callArgs.text).toContain('⏱️ **Interval**: 1d');
    });
  });

  describe('LLM Parameter Extraction', () => {
    it('should handle LLM extraction returning error', async () => {
      mockCallLLMWithTimeout.mockResolvedValue({
        error: 'Token ID is required for price history',
      });

      const result = await getPriceHistory.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(false);
      const callArgs = mockCallback.mock.calls[0][0];
      expect(callArgs.text).toContain('❌ **Error getting price history**');
      expect(callArgs.text).toContain('Failed to extract token ID from message');
    });

    it('should handle LLM extraction throwing error', async () => {
      mockCallLLMWithTimeout.mockRejectedValue(new Error('LLM timeout'));

      const result = await getPriceHistory.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(false);
      const callArgs = mockCallback.mock.calls[0][0];
      expect(callArgs.text).toContain('❌ **Error getting price history**');
      expect(callArgs.text).toContain('Failed to extract token ID from message');
    });

    it('should handle missing tokenId after extraction', async () => {
      mockCallLLMWithTimeout.mockResolvedValue({
        interval: '1d',
        // No tokenId
      });

      const result = await getPriceHistory.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(false);
      const callArgs = mockCallback.mock.calls[0][0];
      expect(callArgs.text).toContain('❌ **Error getting price history**');
      expect(callArgs.text).toContain('Token ID is required for price history retrieval');
    });
  });

  describe('Error Handling', () => {
    it('should handle CLOB client initialization failure', async () => {
      mockInitializeClobClient.mockRejectedValue(new Error('CLOB client init failed'));

      const result = await getPriceHistory.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(false);
      const callArgs = mockCallback.mock.calls[0][0];
      expect(callArgs.text).toContain('❌ **Error getting price history**');
      expect(callArgs.text).toContain('CLOB client init failed');
      expect(callArgs.content.action).toBe('price_history_error');
    });

    it('should handle API errors gracefully', async () => {
      mockCallLLMWithTimeout.mockResolvedValue({
        tokenId: '123456',
        interval: '1d',
      });
      mockClobClient.getPricesHistory.mockRejectedValue(new Error('CLOB API error: 404 Not Found'));

      const result = await getPriceHistory.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(false);
      const callArgs = mockCallback.mock.calls[0][0];
      expect(callArgs.text).toContain('❌ **Error getting price history**');
      expect(callArgs.text).toContain('CLOB API error: 404 Not Found');
      expect(callArgs.text).toContain('Please check:');
      expect(callArgs.content.action).toBe('price_history_error');
    });

    it('should handle unknown errors', async () => {
      mockCallLLMWithTimeout.mockResolvedValue({
        tokenId: '123456',
        interval: '1d',
      });
      mockClobClient.getPricesHistory.mockRejectedValue('Unknown string error');

      const result = await getPriceHistory.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(false);
      const callArgs = mockCallback.mock.calls[0][0];
      expect(callArgs.text).toContain('❌ **Error getting price history**');
      expect(callArgs.text).toContain('Unknown error');
      expect(callArgs.content.error).toBe('Unknown error');
    });
  });

  describe('Edge Cases', () => {
    it('should handle null/undefined price history response', async () => {
      mockCallLLMWithTimeout.mockResolvedValue({
        tokenId: '123456',
        interval: '1d',
      });
      mockClobClient.getPricesHistory.mockResolvedValue(null as any);

      const result = await getPriceHistory.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(true);
      const callArgs = mockCallback.mock.calls[0][0];
      expect(callArgs.text).toContain('📈 **No price history found for Token 123456**');
    });

    it('should handle single data point', async () => {
      const mockPriceHistory: PricePoint[] = [{ t: 1640995200, p: 0.6523 }];

      mockClobClient.getPricesHistory.mockResolvedValue(mockPriceHistory);
      mockCallLLMWithTimeout.mockResolvedValue({
        tokenId: '123456',
        interval: '1d',
      });

      const result = await getPriceHistory.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(true);
      const callArgs = mockCallback.mock.calls[0][0];
      expect(callArgs.text).toContain('📊 **Data Points**: 1');
      // Should not show price trend for single point
      expect(callArgs.text).not.toContain('**Price Trend**');
    });
  });

  describe('Validation', () => {
    it('should pass validation', async () => {
      const isValid = await getPriceHistory.validate(mockRuntime, mockMessage);
      expect(isValid).toBe(true);
    });
  });
});
