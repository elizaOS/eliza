import { placeTypedOrderAction } from '../../src/actions/placeTypedOrder';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';

// Mock the dependencies
vi.mock('../../src/utils/clobClient');
vi.mock('../../utils/llmHelpers');

describe('placeTypedOrderAction', () => {
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
        text: 'Place GTC buy order for 100 shares of token 123456 at $0.50',
      },
    } as any;

    // Mock state
    mockState = {} as State;

    // Mock callback
    mockCallback = vi.fn();
  });

  describe('validate', () => {
    it('should return true when all required settings are present', async () => {
      const isValid = await placeTypedOrderAction.validate(mockRuntime, mockMessage);
      expect(isValid).toBe(true);
    });

    it('should return false when CLOB_API_URL is missing', async () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'CLOB_API_URL') return undefined;
        return 'test-value';
      });

      const isValid = await placeTypedOrderAction.validate(mockRuntime, mockMessage);
      expect(isValid).toBe(false);
    });

    it('should return false when API credentials are missing', async () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'CLOB_API_KEY') return undefined;
        if (key === 'CLOB_API_URL') return 'https://clob.polymarket.com';
        return 'test-value';
      });

      const isValid = await placeTypedOrderAction.validate(mockRuntime, mockMessage);
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

      const isValid = await placeTypedOrderAction.validate(mockRuntime, mockMessage);
      expect(isValid).toBe(false);
    });
  });

  describe('handler', () => {
    beforeEach(async () => {
      // Mock the LLM helper
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;
      callLLMWithTimeout.mockResolvedValue = vi.fn().mockResolvedValue({
        tokenId: '123456',
        side: 'BUY',
        price: 0.5,
        size: 100,
        orderType: 'GTC',
        feeRateBps: '0',
      });

      // Mock the CLOB client
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;
      const mockClobClient = {
        createOrder: vi.fn().mockResolvedValue({ signature: 'test-signature' }),
        postOrder: vi.fn().mockResolvedValue({
          success: true,
          orderId: 'order-123',
          status: 'unmatched',
          orderHashes: ['0xabc123'],
        }),
      };
      initializeClobClientWithCreds.mockResolvedValue = vi.fn().mockResolvedValue(mockClobClient);
    });

    it('should successfully place a GTC order', async () => {
      // Set up mocks for this specific test
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;

      (callLLMWithTimeout as any).mockResolvedValue({
        tokenId: '123456',
        side: 'BUY',
        price: 0.5,
        size: 100,
        orderType: 'GTC',
        feeRateBps: '0',
      });

      const mockClobClient = {
        createOrder: vi.fn().mockResolvedValue({ signature: 'test-signature' }),
        postOrder: vi.fn().mockResolvedValue({
          success: true,
          orderId: 'order-123',
          status: 'unmatched',
          orderHashes: ['0xabc123'],
        }),
      };
      (initializeClobClientWithCreds as any).mockResolvedValue(mockClobClient);

      await placeTypedOrderAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('✅ **GTC Order Placed Successfully**'),
        actions: ['PLACE_TYPED_ORDER'],
        data: {
          success: true,
          orderDetails: expect.objectContaining({
            tokenId: '123456',
            side: 'BUY',
            price: 0.5,
            size: 100,
            orderType: 'GTC',
            feeRateBps: '0',
            totalValue: '50.0000',
          }),
          orderResponse: expect.objectContaining({
            success: true,
            orderId: 'order-123',
            status: 'unmatched',
            orderHashes: ['0xabc123'],
          }),
          timestamp: expect.any(String),
        },
      });
    });

    it('should successfully place a FOK order', async () => {
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;

      const fokMessage = {
        content: { text: 'Create FOK sell order for 50 tokens 789012 at price 0.75' },
      } as any;

      (callLLMWithTimeout as any).mockResolvedValue({
        tokenId: '789012',
        side: 'SELL',
        price: 0.75,
        size: 50,
        orderType: 'FOK',
        feeRateBps: '0',
      });

      const mockClobClient = {
        createOrder: vi.fn().mockResolvedValue({ signature: 'test-signature' }),
        postOrder: vi.fn().mockResolvedValue({
          success: true,
          orderId: 'order-456',
          status: 'matched',
          orderHashes: ['0xdef456'],
        }),
      };
      (initializeClobClientWithCreds as any).mockResolvedValue(mockClobClient);

      await placeTypedOrderAction.handler(mockRuntime, fokMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('✅ **FOK Order Placed Successfully**'),
        actions: ['PLACE_TYPED_ORDER'],
        data: {
          success: true,
          orderDetails: expect.objectContaining({
            tokenId: '789012',
            side: 'SELL',
            price: 0.75,
            size: 50,
            orderType: 'FOK',
            totalValue: '37.5000',
          }),
          orderResponse: expect.objectContaining({
            success: true,
            orderId: 'order-456',
            status: 'matched',
          }),
          timestamp: expect.any(String),
        },
      });
    });

    it('should successfully place a GTD order with expiration', async () => {
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;

      const gtdMessage = {
        content: {
          text: 'Place GTD order to buy 25 shares of 456789 at $0.60 expiring in 2 hours',
        },
      } as any;

      const futureTimestamp = Math.floor(Date.now() / 1000) + 7200; // 2 hours from now

      (callLLMWithTimeout as any).mockResolvedValue({
        tokenId: '456789',
        side: 'BUY',
        price: 0.6,
        size: 25,
        orderType: 'GTD',
        expiration: futureTimestamp,
        feeRateBps: '0',
      });

      const mockClobClient = {
        createOrder: vi.fn().mockResolvedValue({ signature: 'test-signature' }),
        postOrder: vi.fn().mockResolvedValue({
          success: true,
          orderId: 'order-789',
          status: 'unmatched',
          orderHashes: ['0x789abc'],
        }),
      };
      (initializeClobClientWithCreds as any).mockResolvedValue(mockClobClient);

      await placeTypedOrderAction.handler(mockRuntime, gtdMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('✅ **GTD Order Placed Successfully**'),
        actions: ['PLACE_TYPED_ORDER'],
        data: {
          success: true,
          orderDetails: expect.objectContaining({
            tokenId: '456789',
            side: 'BUY',
            price: 0.6,
            size: 25,
            orderType: 'GTD',
            expiration: futureTimestamp,
            totalValue: '15.0000',
          }),
          orderResponse: expect.objectContaining({
            success: true,
            orderId: 'order-789',
            status: 'unmatched',
          }),
          timestamp: expect.any(String),
        },
      });
    });

    it('should handle invalid order parameters', async () => {
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      (callLLMWithTimeout as any).mockResolvedValue({
        error: 'Missing required parameters',
      });

      const invalidMessage = {
        content: { text: 'Place an order without enough details' },
      } as any;

      await placeTypedOrderAction.handler(mockRuntime, invalidMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **Order Placement Failed**'),
        actions: ['PLACE_TYPED_ORDER'],
        data: {
          success: false,
          orderDetails: {},
          orderResponse: { success: false, errorMsg: 'Missing required parameters' },
          timestamp: expect.any(String),
        },
      });
    });

    it('should handle invalid order type', async () => {
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      (callLLMWithTimeout as any).mockResolvedValue({
        tokenId: '123456',
        side: 'BUY',
        price: 0.5,
        size: 100,
        orderType: 'INVALID_TYPE',
        feeRateBps: '0',
      });

      await placeTypedOrderAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **Typed Order Placement Failed**'),
        actions: ['PLACE_TYPED_ORDER'],
        data: {
          success: false,
          orderDetails: {},
          orderResponse: {
            success: false,
            errorMsg: expect.stringContaining('Invalid order type'),
          },
          timestamp: expect.any(String),
        },
      });
    });

    it('should handle price validation errors', async () => {
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;

      (callLLMWithTimeout as any).mockResolvedValue({
        tokenId: '123456',
        side: 'BUY',
        price: 1.5, // Invalid price > 0.99
        size: 100,
        orderType: 'GTC',
        feeRateBps: '0',
      });

      await placeTypedOrderAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **Typed Order Placement Failed**'),
        actions: ['PLACE_TYPED_ORDER'],
        data: {
          success: false,
          orderDetails: {},
          orderResponse: {
            success: false,
            errorMsg: expect.stringContaining('Price 1.5 is outside valid range'),
          },
          timestamp: expect.any(String),
        },
      });
    });

    it('should handle CLOB client errors', async () => {
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;

      (callLLMWithTimeout as any).mockResolvedValue({
        tokenId: '123456',
        side: 'BUY',
        price: 0.5,
        size: 100,
        orderType: 'GTC',
        feeRateBps: '0',
      });

      const mockClobClient = {
        createOrder: vi.fn().mockRejectedValue(new Error('Insufficient balance')),
      };
      (initializeClobClientWithCreds as any).mockResolvedValue(mockClobClient);

      await placeTypedOrderAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **Typed Order Placement Failed**'),
        actions: ['PLACE_TYPED_ORDER'],
        data: {
          success: false,
          orderDetails: {},
          orderResponse: {
            success: false,
            errorMsg:
              'Insufficient balance to place this order. Please check your account balance.',
          },
          timestamp: expect.any(String),
        },
      });
    });

    it('should use regex fallback for structured input', async () => {
      const { callLLMWithTimeout } = (await vi.importMock('../../utils/llmHelpers')) as any;
      const { initializeClobClientWithCreds } = (await vi.importMock(
        '../../src/utils/clobClient'
      )) as any;

      // LLM fails to extract parameters
      (callLLMWithTimeout as any).mockResolvedValue({ error: 'Failed to parse' });

      const structuredMessage = {
        content: { text: 'place GTC 100 123456 at 0.50' },
      } as any;

      const mockClobClient = {
        createOrder: vi.fn().mockResolvedValue({ signature: 'test-signature' }),
        postOrder: vi.fn().mockResolvedValue({
          success: true,
          orderId: 'order-regex',
          status: 'unmatched',
        }),
      };
      (initializeClobClientWithCreds as any).mockResolvedValue(mockClobClient);

      await placeTypedOrderAction.handler(
        mockRuntime,
        structuredMessage,
        mockState,
        {},
        mockCallback
      );

      expect(mockClobClient.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          tokenID: '123456',
          price: 0.5,
          size: 100,
          side: expect.any(String),
        })
      );
    });
  });

  describe('action properties', () => {
    it('should have correct action name', () => {
      expect(placeTypedOrderAction.name).toBe('PLACE_TYPED_ORDER');
    });

    it('should have appropriate similes', () => {
      expect(placeTypedOrderAction.similes).toContain('PLACE_TYPED_ORDER');
      expect(placeTypedOrderAction.similes).toContain('PLACE_GTC_ORDER');
      expect(placeTypedOrderAction.similes).toContain('PLACE_FOK_ORDER');
      expect(placeTypedOrderAction.similes).toContain('PLACE_GTD_ORDER');
    });

    it('should have proper description', () => {
      expect(placeTypedOrderAction.description).toContain('Create and place typed orders');
      expect(placeTypedOrderAction.description).toContain('GTC, FOK, GTD');
      expect(placeTypedOrderAction.description).toContain('explicit order type handling');
    });

    it('should have example conversations for each order type', () => {
      expect(placeTypedOrderAction.examples).toHaveLength(3);
      expect(placeTypedOrderAction.examples[0][0].content.text).toContain('GTC');
      expect(placeTypedOrderAction.examples[1][0].content.text).toContain('FOK');
      expect(placeTypedOrderAction.examples[2][0].content.text).toContain('GTD');
    });
  });
});
