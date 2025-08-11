import { vi, describe, it, expect, beforeEach } from 'vitest';
import { IAgentRuntime, Memory } from '@elizaos/core';
import { calculateMidPriceAction } from '../calculateMidPrice.js';
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

describe('calculateMidPriceAction', () => {
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
        text: 'Calculate the mid price for USDC/WMATIC',
        token0SymbolOrAddress: 'USDC',
        token1SymbolOrAddress: 'WMATIC',
      },
    };
  });

  describe('validate', () => {
    it('should return false if QUICKSWAP_API_URL is not provided', async () => {
      (mockRuntime.getSetting as vi.Mock).mockReturnValue(undefined);
      const result = await calculateMidPriceAction.validate(mockRuntime, mockMemory);
      expect(result).toBe(false);
    });

    it('should return true if QUICKSWAP_API_URL is provided', async () => {
      (mockRuntime.getSetting as vi.Mock).mockReturnValue('http://fake-api-url.com');
      const result = await calculateMidPriceAction.validate(mockRuntime, mockMemory);
      expect(result).toBe(true);
    });
  });

  describe('handler', () => {
    const mockQuickswapClient = {
      CalculateMidPrice: vi.fn(),
    };

    beforeEach(() => {
      (initializeQuickswapClient as vi.Mock).mockResolvedValue(mockQuickswapClient);
      (mockRuntime.getSetting as vi.Mock).mockReturnValue('http://fake-api-url.com');
    });

    it('should call CalculateMidPrice and return success', async () => {
      const midPriceResult = {
        success: true,
        midPrice: '1.23',
        invertedPrice: '0.81',
      };
      mockQuickswapClient.CalculateMidPrice.mockResolvedValue(midPriceResult);

      const result = (await calculateMidPriceAction.handler(mockRuntime, mockMemory)) as {
        text: string;
        data: { success: boolean };
      };

      expect(initializeQuickswapClient).toHaveBeenCalledWith(mockRuntime);
      expect(mockQuickswapClient.CalculateMidPrice).toHaveBeenCalledWith('USDC', 'WMATIC');
      expect(result.text).toContain('Mid Price Calculated');
      expect(result.data?.success).toBe(true);
    });

    it('should return an error message on failed calculation', async () => {
      const midPriceResult = {
        success: false,
        error: 'Invalid pair',
      };
      mockQuickswapClient.CalculateMidPrice.mockResolvedValue(midPriceResult);

      const result = (await calculateMidPriceAction.handler(mockRuntime, mockMemory)) as {
        text: string;
        data: { success: boolean };
      };
      expect(result.text).toContain('Error**: Invalid pair');
      expect(result.data?.success).toBe(false);
    });

    it('should handle Zod validation errors', async () => {
      mockMemory.content = { text: 'some text' }; // Missing params
      const result = (await calculateMidPriceAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };
      expect(result.text).toContain('Error**: Invalid parameters');
    });

    it('should handle generic errors', async () => {
      const error = new Error('Client initialization failed');
      (initializeQuickswapClient as vi.Mock).mockRejectedValue(error);

      const result = (await calculateMidPriceAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };
      expect(result.text).toContain('Error**: Client initialization failed');
    });
  });
});
