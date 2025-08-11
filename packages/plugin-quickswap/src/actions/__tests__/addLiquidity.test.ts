import { vi, describe, it, expect, beforeEach } from 'vitest';
import { IAgentRuntime, Memory } from '@elizaos/core';
import { addLiquidityAction } from '../addLiquidity.js';
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

describe('addLiquidityAction', () => {
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
        text: 'Add liquidity for USDC/WMATIC',
        token0SymbolOrAddress: 'USDC',
        token1SymbolOrAddress: 'WMATIC',
        amount0: '100',
        amount1: '50',
      },
    };
  });

  describe('validate', () => {
    it('should return false if QUICKSWAP_API_URL is not provided', async () => {
      (mockRuntime.getSetting as vi.Mock).mockReturnValue(undefined);
      const result = await addLiquidityAction.validate(mockRuntime, mockMemory);
      expect(result).toBe(false);
    });

    it('should return true if QUICKSWAP_API_URL is provided', async () => {
      (mockRuntime.getSetting as vi.Mock).mockReturnValue('http://fake-api-url.com');
      const result = await addLiquidityAction.validate(mockRuntime, mockMemory);
      expect(result).toBe(true);
    });
  });

  describe('handler', () => {
    const mockQuickswapClient = {
      AddLiquidity: vi.fn(),
    };

    beforeEach(() => {
      (initializeQuickswapClient as vi.Mock).mockResolvedValue(mockQuickswapClient);
      (mockRuntime.getSetting as vi.Mock).mockReturnValue('http://fake-api-url.com');
    });

    it('should return an error for invalid amounts', async () => {
      mockMemory.content.amount0 = '0';
      const result = (await addLiquidityAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };
      expect(result.text).toContain('Error**: Invalid amounts');
    });

    it('should call AddLiquidity and return success on successful addition', async () => {
      const addResult = {
        success: true,
        lpTokensReceived: '70.7',
        transactionHash: '0xghi',
      };
      mockQuickswapClient.AddLiquidity.mockResolvedValue(addResult);

      const result = (await addLiquidityAction.handler(mockRuntime, mockMemory)) as {
        text: string;
        data: { success: boolean };
      };

      expect(initializeQuickswapClient).toHaveBeenCalledWith(mockRuntime);
      expect(mockQuickswapClient.AddLiquidity).toHaveBeenCalledWith('USDC', 'WMATIC', 100, 50);
      expect(result.text).toContain('Liquidity Added Successfully');
      expect(result.data?.success).toBe(true);
    });

    it('should return an error message on failed addition', async () => {
      const addResult = {
        success: false,
        error: 'Slippage too high',
      };
      mockQuickswapClient.AddLiquidity.mockResolvedValue(addResult);

      const result = (await addLiquidityAction.handler(mockRuntime, mockMemory)) as {
        text: string;
        data: { success: boolean };
      };
      expect(result.text).toContain('Error**: Slippage too high');
      expect(result.data?.success).toBe(false);
    });

    it('should handle Zod validation errors for missing parameters', async () => {
      mockMemory.content = { text: 'some text' }; // Missing required params
      const result = (await addLiquidityAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };
      expect(result.text).toContain('Error**: Invalid parameters');
    });

    it('should handle generic errors during execution', async () => {
      const error = new Error('API unavailable');
      (initializeQuickswapClient as vi.Mock).mockRejectedValue(error);

      const result = (await addLiquidityAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };
      expect(result.text).toContain('Error**: API unavailable');
    });
  });
});
