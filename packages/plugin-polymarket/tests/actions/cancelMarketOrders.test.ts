import { cancelMarketOrdersAction } from '../../src/actions/cancelMarketOrders';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';

// Mock the dependencies
vi.mock('../../src/utils/clobClient');
vi.mock('../../utils/llmHelpers');

describe('cancelMarketOrdersAction', () => {
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
        text: 'Cancel all orders for market 0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af',
      },
    } as any;

    // Mock state
    mockState = {} as State;

    // Mock callback
    mockCallback = vi.fn();
  });

  describe('validate', () => {
    it('should return true when all required settings are present and message contains cancel and market keywords', async () => {
      const isValid = await cancelMarketOrdersAction.validate(mockRuntime, mockMessage);
      expect(isValid).toBe(true);
    });

    it('should return false when message does not contain cancel keywords', async () => {
      mockMessage = {
        content: {
          text: 'Get market details for 0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af',
        },
      } as any;

      const isValid = await cancelMarketOrdersAction.validate(mockRuntime, mockMessage);
      expect(isValid).toBe(false);
    });

    it('should return false when message does not contain market keywords', async () => {
      mockMessage = {
        content: {
          text: 'Cancel order abc123',
        },
      } as any;

      const isValid = await cancelMarketOrdersAction.validate(mockRuntime, mockMessage);
      expect(isValid).toBe(false);
    });

    it('should return false when CLOB_API_URL is missing', async () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'CLOB_API_URL') return undefined;
        return 'test-value';
      });

      const isValid = await cancelMarketOrdersAction.validate(mockRuntime, mockMessage);
      expect(isValid).toBe(false);
    });

    it('should return false when API credentials are missing', async () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'CLOB_API_KEY') return undefined;
        if (key === 'CLOB_API_URL') return 'https://clob.polymarket.com';
        return 'test-value';
      });

      const isValid = await cancelMarketOrdersAction.validate(mockRuntime, mockMessage);
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

      const isValid = await cancelMarketOrdersAction.validate(mockRuntime, mockMessage);
      expect(isValid).toBe(false);
    });
  });

  describe('handler', () => {
    it('should successfully cancel market orders with market ID', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      const mockOrderIds = ['order-123', 'order-456', 'order-789'];
      const mockClobClient = {
        cancelMarketOrders: vi.fn().mockResolvedValue({
          canceled: mockOrderIds,
          success: true,
        }),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      callLLMWithTimeout.mockResolvedValue({
        market: '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af',
      });

      await cancelMarketOrdersAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockClobClient.cancelMarketOrders).toHaveBeenCalledWith({
        market: '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af',
        asset_id: undefined,
      });
      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('✅ **Market Orders Cancelled Successfully**'),
        actions: ['CANCEL_MARKET_ORDERS'],
        data: {
          success: true,
          cancelledOrdersCount: 3,
          cancelledOrders: mockOrderIds,
          market: '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af',
          assetId: undefined,
          message: 'Successfully cancelled 3 orders for the specified market',
          timestamp: expect.any(String),
        },
      });
    });

    it('should successfully cancel market orders with asset ID', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      const mockOrderIds = ['order-123', 'order-456'];
      const mockClobClient = {
        cancelMarketOrders: vi.fn().mockResolvedValue({
          canceled: mockOrderIds,
          success: true,
        }),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      callLLMWithTimeout.mockResolvedValue({
        assetId: '52114319501245915516055106046884209969926127482827954674443846427813813222426',
      });

      mockMessage.content.text =
        'Cancel orders for asset 52114319501245915516055106046884209969926127482827954674443846427813813222426';

      await cancelMarketOrdersAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockClobClient.cancelMarketOrders).toHaveBeenCalledWith({
        market: undefined,
        asset_id: '52114319501245915516055106046884209969926127482827954674443846427813813222426',
      });
      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('✅ **Market Orders Cancelled Successfully**'),
        actions: ['CANCEL_MARKET_ORDERS'],
        data: {
          success: true,
          cancelledOrdersCount: 2,
          cancelledOrders: mockOrderIds,
          market: undefined,
          assetId: '52114319501245915516055106046884209969926127482827954674443846427813813222426',
          message: 'Successfully cancelled 2 orders for the specified market',
          timestamp: expect.any(String),
        },
      });
    });

    it('should successfully cancel market orders with both market and asset ID', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      const mockOrderIds = ['order-123'];
      const mockClobClient = {
        cancelMarketOrders: vi.fn().mockResolvedValue({
          canceled: mockOrderIds,
          success: true,
        }),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      callLLMWithTimeout.mockResolvedValue({
        market: '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af',
        assetId: '52114319501245915516055106046884209969926127482827954674443846427813813222426',
      });

      mockMessage.content.text =
        'Cancel orders in market 0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af for token 52114319501245915516055106046884209969926127482827954674443846427813813222426';

      await cancelMarketOrdersAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockClobClient.cancelMarketOrders).toHaveBeenCalledWith({
        market: '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af',
        asset_id: '52114319501245915516055106046884209969926127482827954674443846427813813222426',
      });
    });

    it('should handle response as array of order IDs', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      const mockOrderIds = ['order-123', 'order-456'];
      const mockClobClient = {
        cancelMarketOrders: vi.fn().mockResolvedValue(mockOrderIds),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      callLLMWithTimeout.mockResolvedValue({
        market: '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af',
      });

      await cancelMarketOrdersAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('✅ **Market Orders Cancelled Successfully**'),
        actions: ['CANCEL_MARKET_ORDERS'],
        data: {
          success: true,
          cancelledOrdersCount: 2,
          cancelledOrders: mockOrderIds,
          market: '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af',
          assetId: undefined,
          message: 'Successfully cancelled 2 orders for the specified market',
          timestamp: expect.any(String),
        },
      });
    });

    it('should handle no orders found scenario', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      const mockClobClient = {
        cancelMarketOrders: vi.fn().mockResolvedValue({
          canceled: [],
          success: true,
        }),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      callLLMWithTimeout.mockResolvedValue({
        market: '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af',
      });

      await cancelMarketOrdersAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('✅ **Market Orders Cancelled Successfully**'),
        actions: ['CANCEL_MARKET_ORDERS'],
        data: {
          success: true,
          cancelledOrdersCount: 0,
          cancelledOrders: [],
          market: '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af',
          assetId: undefined,
          message: 'No open orders found to cancel for the specified market',
          timestamp: expect.any(String),
        },
      });
    });

    it('should handle missing market and asset ID error', async () => {
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      callLLMWithTimeout.mockResolvedValue({
        error: 'Missing market or asset ID',
      });

      mockMessage.content.text = 'Cancel orders without specifying market or asset';

      await cancelMarketOrdersAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **Cancel Market Orders Failed**'),
        actions: ['CANCEL_MARKET_ORDERS'],
        data: {
          success: false,
          cancelledOrdersCount: 0,
          cancelledOrders: [],
          message: 'Missing market or asset ID',
          timestamp: expect.any(String),
          error: 'Missing market or asset ID',
        },
      });
    });

    it('should handle regex fallback extraction', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      const mockOrderIds = ['order-123'];
      const mockClobClient = {
        cancelMarketOrders: vi.fn().mockResolvedValue({
          canceled: mockOrderIds,
          success: true,
        }),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      // LLM fails to extract, but regex should work
      callLLMWithTimeout.mockResolvedValue({
        error: 'Missing market or asset ID',
      });

      mockMessage.content.text = 'CANCEL_MARKET_ORDERS market=0x123abc assetId=789def';

      await cancelMarketOrdersAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockClobClient.cancelMarketOrders).toHaveBeenCalledWith({
        market: '0x123abc',
        asset_id: '789def',
      });
    });

    it('should handle authentication errors', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      const mockClobClient = {
        cancelMarketOrders: vi.fn().mockRejectedValue(new Error('Unauthorized access')),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      callLLMWithTimeout.mockResolvedValue({
        market: '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af',
      });

      await cancelMarketOrdersAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **Cancel Market Orders Failed**'),
        actions: ['CANCEL_MARKET_ORDERS'],
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
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      const mockClobClient = {
        cancelMarketOrders: vi.fn().mockRejectedValue(new Error('Network connection failed')),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      callLLMWithTimeout.mockResolvedValue({
        market: '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af',
      });

      await cancelMarketOrdersAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **Cancel Market Orders Failed**'),
        actions: ['CANCEL_MARKET_ORDERS'],
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

    it('should handle invalid market errors', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      const mockClobClient = {
        cancelMarketOrders: vi.fn().mockRejectedValue(new Error('Invalid market ID provided')),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      callLLMWithTimeout.mockResolvedValue({
        market: 'invalid-market-id',
      });

      await cancelMarketOrdersAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **Cancel Market Orders Failed**'),
        actions: ['CANCEL_MARKET_ORDERS'],
        data: {
          success: false,
          cancelledOrdersCount: 0,
          cancelledOrders: [],
          message: 'Invalid market ID or asset ID. Please check the provided identifiers.',
          timestamp: expect.any(String),
          error: 'Invalid market ID provided',
        },
      });
    });

    it('should handle API response with failure status', async () => {
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      const mockClobClient = {
        cancelMarketOrders: vi.fn().mockResolvedValue({
          success: false,
          error: 'No orders found for the specified market',
        }),
      };
      initializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      callLLMWithTimeout.mockResolvedValue({
        market: '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af',
      });

      await expect(
        cancelMarketOrdersAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('No orders found for the specified market');
    });
  });
});
