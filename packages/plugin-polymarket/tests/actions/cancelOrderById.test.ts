import { cancelOrderByIdAction } from '../../src/actions/cancelOrderById';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';

// Mock the dependencies
vi.mock('../../src/utils/clobClient');
vi.mock('../../utils/llmHelpers');

describe('cancelOrderByIdAction', () => {
  let mockRuntime: IAgentRuntime;
  let mockMessage: Memory;
  let mockState: State;
  let mockCallback: any;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Mock runtime with all required settings
    mockRuntime = {
      getSetting: vi.fn((key: string) => {
        const settings: Record<string, string> = {
          CLOB_API_URL: 'https://clob.polymarket.com',
          CLOB_API_KEY: 'test-api-key',
          CLOB_API_SECRET: 'test-api-secret',
          CLOB_API_PASSPHRASE: 'test-passphrase',
          POLYMARKET_PRIVATE_KEY: 'test-private-key',
        };
        return settings[key];
      }),
      useModel: vi.fn(),
    } as any;

    // Mock message
    mockMessage = {
      content: {
        text: 'Cancel order abc123def456',
      },
    } as any;

    // Mock state
    mockState = {} as State;

    // Mock callback
    mockCallback = vi.fn();
  });

  describe('validate', () => {
    it('should return true when all required settings are present', async () => {
      const isValid = await cancelOrderByIdAction.validate(mockRuntime, mockMessage);
      expect(isValid).toBe(true);
    });

    it('should return false when CLOB_API_URL is missing', async () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'CLOB_API_URL') return undefined;
        return 'test-value';
      });

      const isValid = await cancelOrderByIdAction.validate(mockRuntime, mockMessage);
      expect(isValid).toBe(false);
    });

    it('should return false when API credentials are missing', async () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'CLOB_API_KEY') return undefined;
        if (key === 'CLOB_API_URL') return 'https://clob.polymarket.com';
        return 'test-value';
      });

      const isValid = await cancelOrderByIdAction.validate(mockRuntime, mockMessage);
      expect(isValid).toBe(false);
    });

    it('should return false when private key is missing', async () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        const settings: Record<string, string> = {
          CLOB_API_URL: 'https://clob.polymarket.com',
          CLOB_API_KEY: 'test-api-key',
          CLOB_API_SECRET: 'test-api-secret',
          CLOB_API_PASSPHRASE: 'test-passphrase',
        };
        return settings[key];
      });

      const isValid = await cancelOrderByIdAction.validate(mockRuntime, mockMessage);
      expect(isValid).toBe(false);
    });
  });

  describe('handler', () => {
    it('should successfully cancel order with valid order ID', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      // Mock LLM extraction
      callLLMWithTimeout.mockResolvedValue({
        orderId: 'abc123def456',
      });

      const mockClobClient = {
        cancelOrder: vi.fn().mockResolvedValue(true),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      await cancelOrderByIdAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockClobClient.cancelOrder).toHaveBeenCalledWith({ orderID: 'abc123def456' });
      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('✅ **Order Cancelled Successfully**'),
        actions: ['CANCEL_ORDER'],
        data: {
          success: true,
          orderId: 'abc123def456',
          message: 'Order abc123def456 has been successfully cancelled',
          timestamp: expect.any(String),
        },
      });
    });

    it('should handle object response from cancel API', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      // Mock LLM extraction
      callLLMWithTimeout.mockResolvedValue({
        orderId: 'xyz789abc123',
      });

      const mockResponse = {
        success: true,
        message: 'Order cancelled successfully',
      };
      const mockClobClient = {
        cancelOrder: vi.fn().mockResolvedValue(mockResponse),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      await cancelOrderByIdAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('✅ **Order Cancelled Successfully**'),
        actions: ['CANCEL_ORDER'],
        data: {
          success: true,
          orderId: 'xyz789abc123',
          message: 'Order cancelled successfully',
          timestamp: expect.any(String),
        },
      });
    });

    it('should handle missing order ID error', async () => {
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      // Mock LLM extraction failure
      callLLMWithTimeout.mockResolvedValue({
        error: 'Missing order ID',
      });

      // Update message to not match regex fallback
      mockMessage.content.text = 'Cancel something';

      await cancelOrderByIdAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **Order Cancellation Failed**'),
        actions: ['CANCEL_ORDER'],
        data: {
          success: false,
          orderId: '',
          message: 'Missing order ID',
          timestamp: expect.any(String),
          error: 'Missing order ID',
        },
      });
    });

    it('should use regex fallback when LLM fails', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      // Mock LLM extraction failure
      callLLMWithTimeout.mockResolvedValue({
        error: 'Could not extract order ID',
      });

      // Update message to match regex pattern
      mockMessage.content.text = 'Cancel order regex123test456';

      const mockClobClient = {
        cancelOrder: vi.fn().mockResolvedValue(true),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      await cancelOrderByIdAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockClobClient.cancelOrder).toHaveBeenCalledWith({ orderID: 'regex123test456' });
    });

    it('should handle order not found error', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      // Mock LLM extraction
      callLLMWithTimeout.mockResolvedValue({
        orderId: 'notfound123',
      });

      const mockClobClient = {
        cancelOrder: vi.fn().mockRejectedValue(new Error('Order not found')),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      await cancelOrderByIdAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **Order Cancellation Failed**'),
        actions: ['CANCEL_ORDER'],
        data: {
          success: false,
          orderId: '',
          message: 'Order not found. The order may have already been cancelled or filled.',
          timestamp: expect.any(String),
          error: 'Order not found',
        },
      });
    });

    it('should handle authentication errors', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      // Mock LLM extraction
      callLLMWithTimeout.mockResolvedValue({
        orderId: 'auth123test',
      });

      const mockClobClient = {
        cancelOrder: vi.fn().mockRejectedValue(new Error('Unauthorized access')),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      await cancelOrderByIdAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **Order Cancellation Failed**'),
        actions: ['CANCEL_ORDER'],
        data: {
          success: false,
          orderId: '',
          message: 'Authentication failed. Please check your API credentials.',
          timestamp: expect.any(String),
          error: 'Unauthorized access',
        },
      });
    });

    it('should handle network errors', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      // Mock LLM extraction
      callLLMWithTimeout.mockResolvedValue({
        orderId: 'network123test',
      });

      const mockClobClient = {
        cancelOrder: vi.fn().mockRejectedValue(new Error('Network connection failed')),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      await cancelOrderByIdAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **Order Cancellation Failed**'),
        actions: ['CANCEL_ORDER'],
        data: {
          success: false,
          orderId: '',
          message: 'Network connectivity issues. Please try again in a moment.',
          timestamp: expect.any(String),
          error: 'Network connection failed',
        },
      });
    });

    it('should handle already cancelled order error', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      // Mock LLM extraction
      callLLMWithTimeout.mockResolvedValue({
        orderId: 'cancelled123',
      });

      const mockClobClient = {
        cancelOrder: vi.fn().mockRejectedValue(new Error('Order already cancelled')),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      await cancelOrderByIdAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **Order Cancellation Failed**'),
        actions: ['CANCEL_ORDER'],
        data: {
          success: false,
          orderId: '',
          message: 'Order cannot be cancelled because it is already cancelled or fully filled.',
          timestamp: expect.any(String),
          error: 'Order already cancelled',
        },
      });
    });

    it('should handle invalid order ID format', async () => {
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      // Mock LLM extraction with short order ID
      callLLMWithTimeout.mockResolvedValue({
        orderId: 'short',
      });

      await cancelOrderByIdAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **Order Cancellation Failed**'),
        actions: ['CANCEL_ORDER'],
        data: {
          success: false,
          orderId: '',
          message: 'Order ID must be at least 8 characters long',
          timestamp: expect.any(String),
          error: 'Order ID must be at least 8 characters long',
        },
      });
    });

    it('should handle rate limit errors', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      // Mock LLM extraction
      callLLMWithTimeout.mockResolvedValue({
        orderId: 'ratelimit123',
      });

      const mockClobClient = {
        cancelOrder: vi.fn().mockRejectedValue(new Error('Rate limit exceeded')),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      await cancelOrderByIdAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **Order Cancellation Failed**'),
        actions: ['CANCEL_ORDER'],
        data: {
          success: false,
          orderId: '',
          message: 'Rate limit exceeded. Please wait before trying again.',
          timestamp: expect.any(String),
          error: 'Rate limit exceeded',
        },
      });
    });
  });

  describe('action properties', () => {
    it('should have correct action name', () => {
      expect(cancelOrderByIdAction.name).toBe('CANCEL_ORDER');
    });

    it('should have appropriate similes', () => {
      expect(cancelOrderByIdAction.similes).toContain('CANCEL_ORDER');
      expect(cancelOrderByIdAction.similes).toContain('CANCEL_ORDER_BY_ID');
      expect(cancelOrderByIdAction.similes).toContain('STOP_ORDER');
      expect(cancelOrderByIdAction.similes).toContain('REMOVE_ORDER');
      expect(cancelOrderByIdAction.similes).toContain('DELETE_ORDER');
    });

    it('should have proper description', () => {
      expect(cancelOrderByIdAction.description).toContain('Cancel a specific order');
      expect(cancelOrderByIdAction.description).toContain('by its ID');
      expect(cancelOrderByIdAction.description).toContain('exact order ID');
    });

    it('should have example conversations', () => {
      expect(cancelOrderByIdAction.examples).toHaveLength(3);
      expect(cancelOrderByIdAction.examples[0][0].content.text).toContain(
        'Cancel order abc123def456'
      );
      expect(cancelOrderByIdAction.examples[1][0].content.text).toContain(
        'Stop order ID 789xyz012abc'
      );
      expect(cancelOrderByIdAction.examples[2][0].content.text).toContain(
        'Remove the order with ID order-123-456-789'
      );
    });
  });
});
