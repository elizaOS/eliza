import { describe, it, expect, beforeEach, vi } from 'vitest';
import { placeOrderAction } from '../src/actions/placeOrder';
import { OrderSide, OrderType } from '../src/types';
import type { IAgentRuntime, Memory, State, Content } from '@elizaos/core';

// Mock the dependencies
vi.mock('../src/utils/llmHelpers', () => ({
  callLLMWithTimeout: vi.fn(),
}));

vi.mock('../src/utils/clobClient', () => ({
  initializeClobClient: vi.fn(),
}));

const { callLLMWithTimeout } = await import('../src/utils/llmHelpers');
const { initializeClobClient } = await import('../src/utils/clobClient');

describe('placeOrderAction', () => {
  let mockRuntime: IAgentRuntime;
  let mockMessage: Memory;
  let mockState: State;
  let mockCallback: any;
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockRuntime = {
      getSetting: vi.fn((key: string) => {
        if (key === 'CLOB_API_URL') return 'https://clob.polymarket.com';
        return undefined;
      }),
    } as any;

    mockMessage = {
      content: {
        text: 'Buy 100 shares of token 123456 at $0.50 limit order',
      },
    } as Memory;

    mockState = {} as State;
    mockCallback = vi.fn();

    mockClient = {
      createOrder: vi.fn(),
      postOrder: vi.fn(),
    };

    vi.mocked(initializeClobClient).mockResolvedValue(mockClient);
  });

  describe('Action Properties', () => {
    it('should have correct name and similes', () => {
      expect(placeOrderAction.name).toBe('PLACE_ORDER');
      expect(placeOrderAction.similes).toContain('CREATE_ORDER');
      expect(placeOrderAction.similes).toContain('BUY_TOKEN');
      expect(placeOrderAction.similes).toContain('SELL_TOKEN');
      expect(placeOrderAction.similes).toContain('LIMIT_ORDER');
      expect(placeOrderAction.similes).toContain('MARKET_ORDER');
    });

    it('should have proper description', () => {
      expect(placeOrderAction.description).toBe(
        'Create and place limit or market orders on Polymarket'
      );
    });

    it('should have examples', () => {
      expect(placeOrderAction.examples).toBeDefined();
      expect(placeOrderAction.examples?.length).toBeGreaterThan(0);
    });
  });

  describe('Validation', () => {
    it('should validate successfully with CLOB_API_URL', async () => {
      const result = await placeOrderAction.validate(mockRuntime, mockMessage, mockState);
      expect(result).toBe(true);
    });

    it('should fail validation without CLOB_API_URL', async () => {
      vi.mocked(mockRuntime.getSetting).mockReturnValue(undefined);
      const result = await placeOrderAction.validate(mockRuntime, mockMessage, mockState);
      expect(result).toBe(false);
    });
  });

  describe('Successful Order Placement', () => {
    beforeEach(() => {
      vi.mocked(callLLMWithTimeout).mockResolvedValue({
        tokenId: '123456',
        side: 'BUY',
        price: 0.5,
        size: 100,
        orderType: 'GTC',
        feeRateBps: '0',
      });

      mockClient.createOrder.mockResolvedValue({
        salt: 123456,
        maker: '0x1234567890123456789012345678901234567890',
        signer: '0x1234567890123456789012345678901234567890',
        taker: '0x0987654321098765432109876543210987654321',
        tokenId: '123456',
        makerAmount: '50',
        takerAmount: '100',
        expiration: '1234567890',
        nonce: '1234567890',
        feeRateBps: '0',
        side: '0',
        signatureType: 0,
        signature: '0x1234567890abcdef',
      });

      mockClient.postOrder.mockResolvedValue({
        success: true,
        orderId: 'order_123',
        status: 'matched',
        orderHashes: ['0xabcdef123456'],
      });
    });

    it('should place a successful limit buy order', async () => {
      const result = (await placeOrderAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      )) as Content;

      expect(mockClient.createOrder).toHaveBeenCalledWith({
        tokenId: '123456',
        side: OrderSide.BUY,
        price: 0.5,
        size: 100,
        feeRateBps: '0',
      });

      expect(mockClient.postOrder).toHaveBeenCalledWith(expect.any(Object), 'GTC');

      expect(result.text).toContain('Order Placed Successfully');
      expect(result.text).toContain('limit buy order');
      expect(result.text).toContain('**Token ID**: 123456');
      expect(result.text).toContain('**Price**: $0.5000');
      expect(result.text).toContain('**Size**: 100 shares');
      expect((result.data as any)?.success).toBe(true);
    });

    it('should place a successful market sell order', async () => {
      vi.mocked(callLLMWithTimeout).mockResolvedValue({
        tokenId: '789012',
        side: 'SELL',
        price: 0.75,
        size: 50,
        orderType: 'FOK',
        feeRateBps: '10',
      });

      const result = (await placeOrderAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      )) as Content;

      expect(mockClient.createOrder).toHaveBeenCalledWith({
        tokenId: '789012',
        side: OrderSide.SELL,
        price: 0.75,
        size: 50,
        feeRateBps: '10',
      });

      expect(mockClient.postOrder).toHaveBeenCalledWith(expect.any(Object), 'FOK');

      expect(result.text).toContain('Order Placed Successfully');
      expect(result.text).toContain('market sell order');
    });

    it('should handle delayed order status', async () => {
      mockClient.postOrder.mockResolvedValue({
        success: true,
        orderId: 'order_456',
        status: 'delayed',
      });

      const result = (await placeOrderAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      )) as Content;

      expect(result.text).toContain('subject to a matching delay');
    });

    it('should handle unmatched order status', async () => {
      mockClient.postOrder.mockResolvedValue({
        success: true,
        orderId: 'order_789',
        status: 'unmatched',
      });

      const result = (await placeOrderAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      )) as Content;

      expect(result.text).toContain('waiting to be matched');
    });
  });

  describe('LLM Parameter Extraction', () => {
    it('should extract parameters successfully from LLM', async () => {
      vi.mocked(callLLMWithTimeout).mockResolvedValue({
        tokenId: '999999',
        side: 'BUY',
        price: 0.25,
        size: 200,
        orderType: 'GTD',
        feeRateBps: '5',
      });

      mockClient.createOrder.mockResolvedValue({} as any);
      mockClient.postOrder.mockResolvedValue({
        success: true,
        orderId: 'order_999',
      });

      await placeOrderAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockClient.createOrder).toHaveBeenCalledWith({
        tokenId: '999999',
        side: OrderSide.BUY,
        price: 0.25,
        size: 200,
        feeRateBps: '5',
      });
    });

    it('should handle LLM extraction failure with regex fallback', async () => {
      vi.mocked(callLLMWithTimeout).mockRejectedValue(new Error('LLM failed'));

      mockMessage.content!.text = 'Buy 75 tokens of 555555 at price $0.80';

      mockClient.createOrder.mockResolvedValue({} as any);
      mockClient.postOrder.mockResolvedValue({
        success: true,
        orderId: 'order_555',
      });

      await placeOrderAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockClient.createOrder).toHaveBeenCalledWith({
        tokenId: '555555',
        side: OrderSide.BUY,
        price: 0.8,
        size: 75,
        feeRateBps: '0',
      });
    });

    it('should handle LLM error response', async () => {
      vi.mocked(callLLMWithTimeout).mockResolvedValue({
        error: 'Required parameters missing',
      });

      mockMessage.content!.text = 'Invalid order request';

      await expect(
        placeOrderAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('Please provide valid order parameters');
    });
  });

  describe('Parameter Validation and Defaults', () => {
    beforeEach(() => {
      mockClient.createOrder.mockResolvedValue({} as any);
      mockClient.postOrder.mockResolvedValue({
        success: true,
        orderId: 'test_order',
      });
    });

    it('should convert percentage price to decimal', async () => {
      vi.mocked(callLLMWithTimeout).mockResolvedValue({
        tokenId: '123456',
        side: 'BUY',
        price: 75, // 75% should become 0.75
        size: 100,
        orderType: 'GTC',
      });

      await placeOrderAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockClient.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          price: 0.75,
        })
      );
    });

    it('should default invalid side to BUY', async () => {
      vi.mocked(callLLMWithTimeout).mockResolvedValue({
        tokenId: '123456',
        side: 'INVALID',
        price: 0.5,
        size: 100,
      });

      await placeOrderAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockClient.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          side: OrderSide.BUY,
        })
      );
    });

    it('should default invalid order type to GTC', async () => {
      vi.mocked(callLLMWithTimeout).mockResolvedValue({
        tokenId: '123456',
        side: 'BUY',
        price: 0.5,
        size: 100,
        orderType: 'INVALID',
      });

      await placeOrderAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockClient.postOrder).toHaveBeenCalledWith(expect.any(Object), 'GTC');
    });

    it('should map limit to GTC and market to FOK', async () => {
      vi.mocked(callLLMWithTimeout).mockResolvedValue({
        tokenId: '123456',
        side: 'BUY',
        price: 0.5,
        size: 100,
        orderType: 'limit',
      });

      await placeOrderAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockClient.postOrder).toHaveBeenCalledWith(expect.any(Object), 'GTC');
    });
  });

  describe('Error Handling', () => {
    it('should handle missing CLOB_API_URL configuration', async () => {
      vi.mocked(mockRuntime.getSetting).mockReturnValue(undefined);

      await expect(
        placeOrderAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('CLOB_API_URL is required in configuration');
    });

    it('should handle failed order placement', async () => {
      vi.mocked(callLLMWithTimeout).mockResolvedValue({
        tokenId: '123456',
        side: 'BUY',
        price: 0.5,
        size: 100,
      });

      mockClient.createOrder.mockResolvedValue({} as any);
      mockClient.postOrder.mockResolvedValue({
        success: false,
        errorMsg: 'Insufficient balance',
      });

      const result = (await placeOrderAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      )) as Content;

      expect(result.text).toContain('Order Placement Failed');
      expect(result.text).toContain('Insufficient balance');
      expect((result.data as any)?.success).toBe(false);
    });

    it('should handle client initialization error', async () => {
      vi.mocked(callLLMWithTimeout).mockResolvedValue({
        tokenId: '123456',
        side: 'BUY',
        price: 0.5,
        size: 100,
      });

      vi.mocked(initializeClobClient).mockRejectedValue(new Error('Client init failed'));

      await expect(
        placeOrderAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('Client init failed');
    });

    it('should handle order creation error', async () => {
      vi.mocked(callLLMWithTimeout).mockResolvedValue({
        tokenId: '123456',
        side: 'BUY',
        price: 0.5,
        size: 100,
      });

      mockClient.createOrder.mockRejectedValue(new Error('Order creation failed'));

      await expect(
        placeOrderAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('Order creation failed');
    });

    it('should handle unknown errors gracefully', async () => {
      vi.mocked(callLLMWithTimeout).mockResolvedValue({
        tokenId: '123456',
        side: 'BUY',
        price: 0.5,
        size: 100,
      });

      mockClient.createOrder.mockRejectedValue('Unknown error');

      await expect(
        placeOrderAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('Unknown error occurred while placing order');
    });
  });

  describe('Regex Fallback Extraction', () => {
    beforeEach(() => {
      vi.mocked(callLLMWithTimeout).mockRejectedValue(new Error('LLM failed'));
      mockClient.createOrder.mockResolvedValue({} as any);
      mockClient.postOrder.mockResolvedValue({
        success: true,
        orderId: 'regex_order',
      });
    });

    it('should extract sell order from regex', async () => {
      mockMessage.content!.text = 'Sell 25 shares of token 777888 at $0.60';

      await placeOrderAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockClient.createOrder).toHaveBeenCalledWith({
        tokenId: '777888',
        side: OrderSide.SELL,
        price: 0.6,
        size: 25,
        feeRateBps: '0',
      });
    });

    it('should extract market order type from regex', async () => {
      mockMessage.content!.text = 'Place market order to buy 50 tokens of 111222 at $0.75';

      await placeOrderAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockClient.postOrder).toHaveBeenCalledWith(expect.any(Object), 'FOK');
    });

    it('should fail when required parameters are missing', async () => {
      mockMessage.content!.text = 'I want to trade something';

      await expect(
        placeOrderAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('Please provide valid order parameters');
    });
  });

  describe('Response Formatting', () => {
    beforeEach(() => {
      vi.mocked(callLLMWithTimeout).mockResolvedValue({
        tokenId: '123456',
        side: 'BUY',
        price: 0.5,
        size: 100,
        orderType: 'GTC',
        feeRateBps: '10',
      });

      mockClient.createOrder.mockResolvedValue({} as any);
    });

    it('should format successful response with all details', async () => {
      mockClient.postOrder.mockResolvedValue({
        success: true,
        orderId: 'order_123',
        status: 'matched',
        orderHashes: ['0xabcdef123456', '0x789012345678'],
      });

      const result = (await placeOrderAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      )) as Content;

      expect(result.text).toContain('**Order ID**: order_123');
      expect(result.text).toContain('**Status**: matched');
      expect(result.text).toContain('**Transaction Hash(es)**: 0xabcdef123456, 0x789012345678');
      expect(result.text).toContain('immediately matched and executed');
      expect(result.text).toContain('**Total Value**: $50.0000');
      expect(result.text).toContain('**Fee Rate**: 10 bps');
    });

    it('should include proper data structure in response', async () => {
      mockClient.postOrder.mockResolvedValue({
        success: true,
        orderId: 'order_456',
      });

      const result = (await placeOrderAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      )) as Content;

      expect(result.data).toEqual({
        success: true,
        orderDetails: {
          tokenId: '123456',
          side: 'BUY',
          price: 0.5,
          size: 100,
          orderType: 'GTC',
          feeRateBps: '10',
          totalValue: '50.0000',
        },
        orderResponse: {
          success: true,
          orderId: 'order_456',
        },
        timestamp: expect.any(String),
      });
    });
  });
});
