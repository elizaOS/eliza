import { vi, describe, it, expect, beforeEach } from 'vitest';
import { IAgentRuntime, Memory } from '@elizaos/core';
import { swapTokensAction } from '../swapTokens.js';
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

describe('swapTokensAction', () => {
  let mockRuntime: IAgentRuntime;
  let mockMemory: Memory;

  beforeEach(() => {
    vi.clearAllMocks();

    mockRuntime = {
      getSetting: vi.fn(),
      getService: vi.fn(),
      // Add other necessary IAgentRuntime methods if needed
    } as unknown as IAgentRuntime;

    mockMemory = {
      entityId: 'user-id' as any,
      roomId: 'room-id' as any,
      content: {
        text: 'Swap 10 USDC for WMATIC',
        inputTokenSymbolOrAddress: 'USDC',
        outputTokenSymbolOrAddress: 'WMATIC',
        amount: '10',
      },
    };
  });

  describe('validate', () => {
    it('should return false if QUICKSWAP_API_URL is not provided', async () => {
      (mockRuntime.getSetting as vi.Mock).mockReturnValue(undefined);
      const result = await swapTokensAction.validate(mockRuntime, mockMemory);
      expect(result).toBe(false);
    });

    it('should return true if QUICKSWAP_API_URL is provided', async () => {
      (mockRuntime.getSetting as vi.Mock).mockReturnValue('http://fake-api-url.com');
      const result = await swapTokensAction.validate(mockRuntime, mockMemory);
      expect(result).toBe(true);
    });
  });

  describe('handler', () => {
    const mockQuickswapClient = {
      Swap: vi.fn(),
    };

    beforeEach(() => {
      (initializeQuickswapClient as vi.Mock).mockResolvedValue(mockQuickswapClient);
      (mockRuntime.getSetting as vi.Mock).mockReturnValue('http://fake-api-url.com');
    });

    it('should return an error for invalid amount', async () => {
      mockMemory.content.amount = '0';
      const result = (await swapTokensAction.handler(mockRuntime, mockMemory)) as { text: string };
      expect(result.text).toContain('Error**: Invalid amount');
    });

    it('should call Swap and return success on successful swap', async () => {
      const swapResult = {
        success: true,
        amountReceived: '123',
        transactionHash: '0xabc',
      };
      mockQuickswapClient.Swap.mockResolvedValue(swapResult);

      const result = (await swapTokensAction.handler(mockRuntime, mockMemory)) as {
        text: string;
        data: { success: boolean };
      };

      expect(initializeQuickswapClient).toHaveBeenCalledWith(mockRuntime);
      expect(mockQuickswapClient.Swap).toHaveBeenCalledWith('USDC', 'WMATIC', 10);
      expect(result.text).toContain('Swap Executed Successfully');
      expect(result.data?.success).toBe(true);
    });

    it('should return an error message on failed swap', async () => {
      const swapResult = {
        success: false,
        error: 'Insufficient funds',
      };
      mockQuickswapClient.Swap.mockResolvedValue(swapResult);

      const result = (await swapTokensAction.handler(mockRuntime, mockMemory)) as {
        text: string;
        data: { success: boolean };
      };
      expect(result.text).toContain('Error**: Insufficient funds');
      expect(result.data?.success).toBe(false);
    });

    it('should handle Zod validation errors for missing parameters', async () => {
      mockMemory.content = { text: 'some text' }; // Missing required params
      const result = (await swapTokensAction.handler(mockRuntime, mockMemory)) as { text: string };
      expect(result.text).toContain('Error**: Invalid parameters');
    });

    it('should handle generic errors during execution', async () => {
      const error = new Error('Network failure');
      (initializeQuickswapClient as vi.Mock).mockRejectedValue(error);

      const result = (await swapTokensAction.handler(mockRuntime, mockMemory)) as { text: string };
      expect(result.text).toContain('Error**: Network failure');
    });
  });
});
