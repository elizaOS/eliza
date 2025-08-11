import { vi, describe, it, expect, beforeEach } from 'vitest';
import { IAgentRuntime, Memory } from '@elizaos/core';
import { removeLiquidityAction } from '../removeLiquidity.js';
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

describe('removeLiquidityAction', () => {
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
        text: 'Remove 10 LP tokens from the USDC/WMATIC pool',
        token0SymbolOrAddress: 'USDC',
        token1SymbolOrAddress: 'WMATIC',
        lpTokensAmount: '10',
      },
    };
  });

  describe('validate', () => {
    it('should return false if QUICKSWAP_API_URL is not provided', async () => {
      (mockRuntime.getSetting as vi.Mock).mockReturnValue(undefined);
      const result = await removeLiquidityAction.validate(mockRuntime, mockMemory);
      expect(result).toBe(false);
    });

    it('should return true if QUICKSWAP_API_URL is provided', async () => {
      (mockRuntime.getSetting as vi.Mock).mockReturnValue('http://fake-api-url.com');
      const result = await removeLiquidityAction.validate(mockRuntime, mockMemory);
      expect(result).toBe(true);
    });
  });

  describe('handler', () => {
    const mockQuickswapClient = {
      RemoveLiquidity: vi.fn(),
    };

    beforeEach(() => {
      (initializeQuickswapClient as vi.Mock).mockResolvedValue(mockQuickswapClient);
      (mockRuntime.getSetting as vi.Mock).mockReturnValue('http://fake-api-url.com');
    });

    it('should return an error for invalid LP token amount', async () => {
      mockMemory.content.lpTokensAmount = '-5';
      const result = (await removeLiquidityAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };
      expect(result.text).toContain('Error**: Invalid LP token amount');
    });

    it('should call RemoveLiquidity and return success on successful removal', async () => {
      const removeResult = {
        success: true,
        token0Received: '50',
        token1Received: '50',
        transactionHash: '0xdef',
      };
      mockQuickswapClient.RemoveLiquidity.mockResolvedValue(removeResult);

      const result = (await removeLiquidityAction.handler(mockRuntime, mockMemory)) as {
        text: string;
        data: { success: boolean };
      };

      expect(initializeQuickswapClient).toHaveBeenCalledWith(mockRuntime);
      expect(mockQuickswapClient.RemoveLiquidity).toHaveBeenCalledWith('USDC', 'WMATIC', 10);
      expect(result.text).toContain('Liquidity Removed Successfully');
      expect(result.data?.success).toBe(true);
    });

    it('should return an error message on failed removal', async () => {
      const removeResult = {
        success: false,
        error: 'Pool not found',
      };
      mockQuickswapClient.RemoveLiquidity.mockResolvedValue(removeResult);

      const result = (await removeLiquidityAction.handler(mockRuntime, mockMemory)) as {
        text: string;
        data: { success: boolean };
      };
      expect(result.text).toContain('Error**: Pool not found');
      expect(result.data?.success).toBe(false);
    });

    it('should handle Zod validation errors for missing parameters', async () => {
      mockMemory.content = { text: 'some text' }; // Missing required params
      const result = (await removeLiquidityAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };
      expect(result.text).toContain('Error**: Invalid parameters');
    });

    it('should handle generic errors during execution', async () => {
      const error = new Error('RPC timeout');
      (initializeQuickswapClient as vi.Mock).mockRejectedValue(error);

      const result = (await removeLiquidityAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };
      expect(result.text).toContain('Error**: RPC timeout');
    });
  });
});
