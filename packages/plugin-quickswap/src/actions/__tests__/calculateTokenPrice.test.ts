import { vi, describe, it, expect, beforeEach } from 'vitest';
import { IAgentRuntime, Memory } from '@elizaos/core';
import { calculateTokenPriceAction } from '../calculateTokenPrice.js';
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

describe('calculateTokenPriceAction', () => {
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
        text: 'Calculate the price of WMATIC against USDC',
        tokenSymbolOrAddress: 'WMATIC',
        vsTokenSymbolOrAddress: 'USDC',
      },
    };
  });

  describe('validate', () => {
    it('should return false if QUICKSWAP_API_URL is not provided', async () => {
      (mockRuntime.getSetting as vi.Mock).mockReturnValue(undefined);
      const result = await calculateTokenPriceAction.validate(mockRuntime, mockMemory);
      expect(result).toBe(false);
    });

    it('should return true if QUICKSWAP_API_URL is provided', async () => {
      (mockRuntime.getSetting as vi.Mock).mockReturnValue('http://fake-api-url.com');
      const result = await calculateTokenPriceAction.validate(mockRuntime, mockMemory);
      expect(result).toBe(true);
    });
  });

  describe('handler', () => {
    const mockQuickswapClient = {
      CalculateTokenPrice: vi.fn(),
    };

    beforeEach(() => {
      (initializeQuickswapClient as vi.Mock).mockResolvedValue(mockQuickswapClient);
      (mockRuntime.getSetting as vi.Mock).mockReturnValue('http://fake-api-url.com');
    });

    it('should call CalculateTokenPrice and return success', async () => {
      const priceResult = {
        success: true,
        price: '1.23',
      };
      mockQuickswapClient.CalculateTokenPrice.mockResolvedValue(priceResult);

      const result = (await calculateTokenPriceAction.handler(mockRuntime, mockMemory)) as {
        text: string;
        data: { success: boolean };
      };

      expect(initializeQuickswapClient).toHaveBeenCalledWith(mockRuntime);
      expect(mockQuickswapClient.CalculateTokenPrice).toHaveBeenCalledWith('WMATIC', 'USDC');
      expect(result.text).toContain('Token Price Calculated');
      expect(result.data?.success).toBe(true);
    });

    it('should return an error message on failed calculation', async () => {
      const priceResult = {
        success: false,
        error: 'Could not fetch price',
      };
      mockQuickswapClient.CalculateTokenPrice.mockResolvedValue(priceResult);

      const result = (await calculateTokenPriceAction.handler(mockRuntime, mockMemory)) as {
        text: string;
        data: { success: boolean };
      };
      expect(result.text).toContain('Error**: Could not fetch price');
      expect(result.data?.success).toBe(false);
    });

    it('should handle Zod validation errors', async () => {
      mockMemory.content = { text: 'some text' }; // Missing params
      const result = (await calculateTokenPriceAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };
      expect(result.text).toContain('Error**: Invalid parameters');
    });

    it('should handle generic errors', async () => {
      const error = new Error('Network error');
      (initializeQuickswapClient as vi.Mock).mockRejectedValue(error);

      const result = (await calculateTokenPriceAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };
      expect(result.text).toContain('Error**: Network error');
    });
  });
});
