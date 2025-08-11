import { vi, describe, it, expect, beforeEach } from 'vitest';
import { IAgentRuntime, Memory } from '@elizaos/core';
import { executeLimitOrderStopLossTakeProfitAction } from '../executeLimitOrderStopLossTakeProfit.js';
import { initializeQuickswapClient } from '../../utils/quickswapClient.js';

// Mock core modules
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

// Mock local modules
vi.mock('../../utils/quickswapClient.js');

describe('executeLimitOrderStopLossTakeProfitAction', () => {
  let mockRuntime: IAgentRuntime;
  let mockMemory: Memory;

  beforeEach(() => {
    vi.clearAllMocks();

    mockRuntime = {
      getSetting: vi.fn(),
      getService: vi.fn(),
    } as unknown as IAgentRuntime;

    mockMemory = {
      entityId: 'user-id' as any,
      roomId: 'room-id' as any,
      content: {
        text: 'Execute a limit order',
        tradeType: 'limit',
        inputTokenSymbolOrAddress: 'WMATIC',
        outputTokenSymbolOrAddress: 'USDC',
        amount: '100',
        price: '1.5',
      },
    };
  });

  describe('validate', () => {
    it('should return false if QUICKSWAP_API_URL is not provided', async () => {
      (mockRuntime.getSetting as vi.Mock).mockReturnValue(undefined);
      const result = await executeLimitOrderStopLossTakeProfitAction.validate(
        mockRuntime,
        mockMemory
      );
      expect(result).toBe(false);
    });

    it('should return true if QUICKSWAP_API_URL is provided', async () => {
      (mockRuntime.getSetting as vi.Mock).mockReturnValue('http://fake-api-url.com');
      const result = await executeLimitOrderStopLossTakeProfitAction.validate(
        mockRuntime,
        mockMemory
      );
      expect(result).toBe(true);
    });
  });

  describe('handler', () => {
    const mockQuickswapClient = {
      ExecuteOrder: vi.fn(),
    };

    beforeEach(() => {
      (initializeQuickswapClient as vi.Mock).mockResolvedValue(mockQuickswapClient);
      (mockRuntime.getSetting as vi.Mock).mockReturnValue('http://fake-api-url.com');
    });

    it('should return an error for invalid amount', async () => {
      mockMemory.content.amount = '-10';
      const result = (await executeLimitOrderStopLossTakeProfitAction.handler(
        mockRuntime,
        mockMemory
      )) as { text: string };
      expect(result.text).toContain('Error**: Invalid amount');
    });

    it('should call ExecuteOrder and return success for a limit order', async () => {
      const orderResult = { success: true, transactionHash: '0xlimit' };
      mockQuickswapClient.ExecuteOrder.mockResolvedValue(orderResult);

      const result = (await executeLimitOrderStopLossTakeProfitAction.handler(
        mockRuntime,
        mockMemory
      )) as { text: string; data: { success: boolean } };

      expect(mockQuickswapClient.ExecuteOrder).toHaveBeenCalledWith({
        tradeType: 'limit',
        inputTokenSymbolOrAddress: 'WMATIC',
        outputTokenSymbolOrAddress: 'USDC',
        amount: '100',
        price: '1.5',
        stopPrice: undefined,
        takeProfitPrice: undefined,
      });
      expect(result.text).toContain('LIMIT Order Executed Successfully');
      expect(result.data?.success).toBe(true);
    });

    it('should return an error message on failed execution', async () => {
      const orderResult = { success: false, error: 'Execution failed' };
      mockQuickswapClient.ExecuteOrder.mockResolvedValue(orderResult);

      const result = (await executeLimitOrderStopLossTakeProfitAction.handler(
        mockRuntime,
        mockMemory
      )) as { text: string; data: { success: boolean } };
      expect(result.text).toContain('Error**: Execution failed');
      expect(result.data?.success).toBe(false);
    });

    it('should handle Zod validation errors', async () => {
      mockMemory.content = { text: 'some text' }; // Missing params
      const result = (await executeLimitOrderStopLossTakeProfitAction.handler(
        mockRuntime,
        mockMemory
      )) as { text: string };
      expect(result.text).toContain('Error**: Invalid parameters');
    });

    it('should handle generic errors', async () => {
      const error = new Error('Client error');
      (initializeQuickswapClient as vi.Mock).mockRejectedValue(error);

      const result = (await executeLimitOrderStopLossTakeProfitAction.handler(
        mockRuntime,
        mockMemory
      )) as { text: string };
      expect(result.text).toContain('Error**: Client error');
    });
  });
});
