import { cancelAllOrdersAction } from '../../src/actions/cancelAllOrders';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';

// Mock the dependencies
vi.mock('../../src/utils/clobClient');

describe('cancelAllOrdersAction', () => {
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
        text: 'Cancel all my open orders',
      },
    } as any;

    // Mock state
    mockState = {} as State;

    // Mock callback
    mockCallback = vi.fn();
  });

  describe('validate', () => {
    it('should return true when all required settings are present', async () => {
      const isValid = await cancelAllOrdersAction.validate(mockRuntime, mockMessage);
      expect(isValid).toBe(true);
    });

    it('should return false when CLOB_API_URL is missing', async () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'CLOB_API_URL') return undefined;
        return 'test-value';
      });

      const isValid = await cancelAllOrdersAction.validate(mockRuntime, mockMessage);
      expect(isValid).toBe(false);
    });

    it('should return false when API credentials are missing', async () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'CLOB_API_KEY') return undefined;
        if (key === 'CLOB_API_URL') return 'https://clob.polymarket.com';
        return 'test-value';
      });

      const isValid = await cancelAllOrdersAction.validate(mockRuntime, mockMessage);
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

      const isValid = await cancelAllOrdersAction.validate(mockRuntime, mockMessage);
      expect(isValid).toBe(false);
    });
  });

  describe('handler', () => {
    it('should successfully cancel orders when response is an array', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;

      const mockOrderIds = ['order-123', 'order-456', 'order-789'];
      const mockClobClient = {
        cancelAll: vi.fn().mockResolvedValue(mockOrderIds),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      await cancelAllOrdersAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockClobClient.cancelAll).toHaveBeenCalled();
      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('✅ **All Orders Cancelled Successfully**'),
        actions: ['CANCEL_ALL_ORDERS'],
        data: {
          success: true,
          cancelledOrdersCount: 3,
          cancelledOrders: mockOrderIds,
          message: 'Successfully cancelled 3 open orders',
          timestamp: expect.any(String),
        },
      });
    });

    it('should handle successful cancellation with object response', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;

      const mockResponse = {
        success: true,
        orderIds: ['order-123', 'order-456'],
        message: 'Orders cancelled successfully',
      };
      const mockClobClient = {
        cancelAll: vi.fn().mockResolvedValue(mockResponse),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      await cancelAllOrdersAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('✅ **All Orders Cancelled Successfully**'),
        actions: ['CANCEL_ALL_ORDERS'],
        data: {
          success: true,
          cancelledOrdersCount: 2,
          cancelledOrders: ['order-123', 'order-456'],
          message: 'Orders cancelled successfully',
          timestamp: expect.any(String),
        },
      });
    });

    it('should handle no open orders scenario', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;

      const mockClobClient = {
        cancelAll: vi.fn().mockResolvedValue([]), // Empty array - no orders
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      await cancelAllOrdersAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('✅ **All Orders Cancelled Successfully**'),
        actions: ['CANCEL_ALL_ORDERS'],
        data: {
          success: true,
          cancelledOrdersCount: 0,
          cancelledOrders: [],
          message: 'No open orders found to cancel',
          timestamp: expect.any(String),
        },
      });
    });

    it('should handle simple success response', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;

      const mockClobClient = {
        cancelAll: vi.fn().mockResolvedValue(true), // Simple boolean response
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      await cancelAllOrdersAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('✅ **All Orders Cancelled Successfully**'),
        actions: ['CANCEL_ALL_ORDERS'],
        data: {
          success: true,
          cancelledOrdersCount: 0,
          cancelledOrders: [],
          message: 'All open orders have been successfully cancelled',
          timestamp: expect.any(String),
        },
      });
    });

    it('should handle authentication errors', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;

      const mockClobClient = {
        cancelAll: vi.fn().mockRejectedValue(new Error('Unauthorized access')),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      await cancelAllOrdersAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **Cancel All Orders Failed**'),
        actions: ['CANCEL_ALL_ORDERS'],
        data: {
          success: false,
          cancelledOrdersCount: 0,
          cancelledOrders: [],
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

      const mockClobClient = {
        cancelAll: vi.fn().mockRejectedValue(new Error('Network connection failed')),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      await cancelAllOrdersAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **Cancel All Orders Failed**'),
        actions: ['CANCEL_ALL_ORDERS'],
        data: {
          success: false,
          cancelledOrdersCount: 0,
          cancelledOrders: [],
          message: 'Network connectivity issues. Please try again in a moment.',
          timestamp: expect.any(String),
          error: 'Network connection failed',
        },
      });
    });

    it('should handle rate limit errors', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;

      const mockClobClient = {
        cancelAll: vi.fn().mockRejectedValue(new Error('Rate limit exceeded')),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      await cancelAllOrdersAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **Cancel All Orders Failed**'),
        actions: ['CANCEL_ALL_ORDERS'],
        data: {
          success: false,
          cancelledOrdersCount: 0,
          cancelledOrders: [],
          message: 'Rate limit exceeded. Please wait before trying again.',
          timestamp: expect.any(String),
          error: 'Rate limit exceeded',
        },
      });
    });

    it('should handle failed object response', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;

      const mockResponse = {
        success: false,
        error: 'Operation failed',
      };
      const mockClobClient = {
        cancelAll: vi.fn().mockResolvedValue(mockResponse),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      await cancelAllOrdersAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **Cancel All Orders Failed**'),
        actions: ['CANCEL_ALL_ORDERS'],
        data: {
          success: false,
          cancelledOrdersCount: 0,
          cancelledOrders: [],
          message: 'Operation failed',
          timestamp: expect.any(String),
          error: 'Operation failed',
        },
      });
    });

    it('should handle large number of cancelled orders', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;

      // Create 15 mock order IDs to test truncation
      const mockOrderIds = Array.from({ length: 15 }, (_, i) => `order-${i + 1}`);
      const mockClobClient = {
        cancelAll: vi.fn().mockResolvedValue(mockOrderIds),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      await cancelAllOrdersAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('... and 5 more orders'), // Should show truncation
        actions: ['CANCEL_ALL_ORDERS'],
        data: {
          success: true,
          cancelledOrdersCount: 15,
          cancelledOrders: mockOrderIds,
          message: 'Successfully cancelled 15 open orders',
          timestamp: expect.any(String),
        },
      });
    });
  });

  describe('action properties', () => {
    it('should have correct action name', () => {
      expect(cancelAllOrdersAction.name).toBe('CANCEL_ALL_ORDERS');
    });

    it('should have appropriate similes', () => {
      expect(cancelAllOrdersAction.similes).toContain('CANCEL_ALL_ORDERS');
      expect(cancelAllOrdersAction.similes).toContain('CANCEL_ALL');
      expect(cancelAllOrdersAction.similes).toContain('CANCEL_ORDERS');
      expect(cancelAllOrdersAction.similes).toContain('STOP_ALL_ORDERS');
      expect(cancelAllOrdersAction.similes).toContain('CANCEL_EVERYTHING');
    });

    it('should have proper description', () => {
      expect(cancelAllOrdersAction.description).toContain('Cancel all open orders');
      expect(cancelAllOrdersAction.description).toContain('authenticated user');
      expect(cancelAllOrdersAction.description).toContain('every pending order');
    });

    it('should have example conversations', () => {
      expect(cancelAllOrdersAction.examples).toHaveLength(3);
      expect(cancelAllOrdersAction.examples[0][0].content.text).toContain(
        'Cancel all my open orders'
      );
      expect(cancelAllOrdersAction.examples[1][0].content.text).toContain('Stop all my trading');
      expect(cancelAllOrdersAction.examples[2][0].content.text).toBe('CANCEL_ALL_ORDERS');
    });
  });
});
