import { vi, describe, it, expect, beforeEach } from 'vitest';
import { IAgentRuntime, Memory } from '@elizaos/core';
import { calculateLiquidityValueAction } from '../calculateLiquidityValue.js';
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

describe('calculateLiquidityValueAction', () => {
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
        text: 'Calculate the value of 10 LP tokens for the USDC/WMATIC pool',
        token0SymbolOrAddress: 'USDC',
        token1SymbolOrAddress: 'WMATIC',
        lpTokensAmount: '10',
      },
    };
  });

  describe('validate', () => {
    it('should return false if QUICKSWAP_API_URL is not provided', async () => {
      (mockRuntime.getSetting as vi.Mock).mockReturnValue(undefined);
      const result = await calculateLiquidityValueAction.validate(mockRuntime, mockMemory);
      expect(result).toBe(false);
    });

    it('should return true if QUICKSWAP_API_URL is provided', async () => {
      (mockRuntime.getSetting as vi.Mock).mockReturnValue('http://fake-api-url.com');
      const result = await calculateLiquidityValueAction.validate(mockRuntime, mockMemory);
      expect(result).toBe(true);
    });
  });

  describe('handler', () => {
    const mockQuickswapClient = {
      CalculateLiquidityValue: vi.fn(),
    };

    beforeEach(() => {
      (initializeQuickswapClient as vi.Mock).mockResolvedValue(mockQuickswapClient);
      (mockRuntime.getSetting as vi.Mock).mockReturnValue('http://fake-api-url.com');
    });

    it('should return an error for invalid LP token amount', async () => {
      mockMemory.content.lpTokensAmount = '0';
      const result = (await calculateLiquidityValueAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };
      expect(result.text).toContain('Error**: Invalid LP token amount');
    });

    it('should call CalculateLiquidityValue and return success', async () => {
      const calcResult = {
        success: true,
        token0Value: '50',
        token1Value: '50',
      };
      mockQuickswapClient.CalculateLiquidityValue.mockResolvedValue(calcResult);

      const result = (await calculateLiquidityValueAction.handler(mockRuntime, mockMemory)) as {
        text: string;
        data: { success: boolean };
      };

      expect(initializeQuickswapClient).toHaveBeenCalledWith(mockRuntime);
      expect(mockQuickswapClient.CalculateLiquidityValue).toHaveBeenCalledWith(
        'USDC',
        'WMATIC',
        10
      );
      expect(result.text).toContain('Liquidity Value Calculated');
      expect(result.data?.success).toBe(true);
    });

    it('should return an error message on failed calculation', async () => {
      const calcResult = {
        success: false,
        error: 'Pool does not exist',
      };
      mockQuickswapClient.CalculateLiquidityValue.mockResolvedValue(calcResult);

      const result = (await calculateLiquidityValueAction.handler(mockRuntime, mockMemory)) as {
        text: string;
        data: { success: boolean };
      };
      expect(result.text).toContain('Error**: Pool does not exist');
      expect(result.data?.success).toBe(false);
    });

    it('should handle Zod validation errors', async () => {
      mockMemory.content = { text: 'some text' }; // Missing params
      const result = (await calculateLiquidityValueAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };
      expect(result.text).toContain('Error**: Invalid parameters');
    });

    it('should handle generic errors', async () => {
      const error = new Error('Something went wrong');
      (initializeQuickswapClient as vi.Mock).mockRejectedValue(error);

      const result = (await calculateLiquidityValueAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };
      expect(result.text).toContain('Error**: Something went wrong');
    });
  });
});
