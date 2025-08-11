import { vi, describe, it, expect, beforeEach } from 'vitest';
import { IAgentRuntime, Memory } from '@elizaos/core';
import { calculatePriceImpactAction } from '../calculatePriceImpact.js';
import { initializeQuickswapClient } from '../../utils/quickswapClient.js';
import { callLLMWithTimeout } from '../../utils/llmHelpers.js';

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
vi.mock('../../utils/llmHelpers.js');

describe('calculatePriceImpactAction', () => {
  let mockRuntime: IAgentRuntime;
  let mockMemory: Memory;
  const mockQuickswapClient = {
    calculatePriceImpact: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockRuntime = {
      getSetting: vi.fn().mockReturnValue('http://fake-api-url.com'),
      getService: vi.fn(),
    } as unknown as IAgentRuntime;

    mockMemory = {
      entityId: 'user-id' as any,
      roomId: 'room-id' as any,
      content: {
        text: 'calculate price impact for 10 WMATIC to USDC',
      },
    };

    (initializeQuickswapClient as vi.Mock).mockResolvedValue(mockQuickswapClient);
  });

  describe('validate', () => {
    it('should return false if QUICKSWAP_API_URL is not provided', async () => {
      (mockRuntime.getSetting as vi.Mock).mockReturnValue(undefined);
      const result = await calculatePriceImpactAction.validate(mockRuntime, mockMemory);
      expect(result).toBe(false);
    });

    it('should return true if QUICKSWAP_API_URL is provided', async () => {
      const result = await calculatePriceImpactAction.validate(mockRuntime, mockMemory);
      expect(result).toBe(true);
    });
  });

  describe('handler', () => {
    it('should use LLM to extract params and return success on successful calculation', async () => {
      const llmResult = {
        inputTokenSymbolOrAddress: 'WMATIC',
        outputTokenSymbolOrAddress: 'USDC',
        inputAmount: '10',
      };
      (callLLMWithTimeout as vi.Mock).mockResolvedValue(llmResult);
      mockQuickswapClient.calculatePriceImpact.mockResolvedValue({
        success: true,
        priceImpactPercentage: '0.5',
        newPrice: '1.22',
      });

      const result = (await calculatePriceImpactAction.handler(mockRuntime, mockMemory)) as {
        text: string;
        data: { success: boolean };
      };

      expect(callLLMWithTimeout).toHaveBeenCalled();
      expect(mockQuickswapClient.calculatePriceImpact).toHaveBeenCalledWith('WMATIC', 'USDC', 10);
      expect(result.text).toContain('Price Impact Calculation');
      expect(result.data?.success).toBe(true);
    });

    it('should use regex fallback when LLM fails and return success', async () => {
      (callLLMWithTimeout as vi.Mock).mockRejectedValue(new Error('LLM timeout'));
      mockQuickswapClient.calculatePriceImpact.mockResolvedValue({
        success: true,
        priceImpactPercentage: '0.5',
        newPrice: '1.22',
      });

      const result = (await calculatePriceImpactAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };

      expect(mockQuickswapClient.calculatePriceImpact).toHaveBeenCalledWith('WMATIC', 'USDC', 10);
      expect(result.text).toContain('Price Impact Calculation');
    });

    it('should return error if both LLM and regex fail to extract params', async () => {
      (callLLMWithTimeout as vi.Mock).mockRejectedValue(new Error('LLM timeout'));
      mockMemory.content.text = 'bad input';
      const result = (await calculatePriceImpactAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };
      expect(result.text).toContain('Error**: Please specify the input amount');
    });

    it('should return error if quickswapClient fails', async () => {
      (callLLMWithTimeout as vi.Mock).mockResolvedValue({
        inputTokenSymbolOrAddress: 'WMATIC',
        outputTokenSymbolOrAddress: 'USDC',
        inputAmount: '10',
      });
      mockQuickswapClient.calculatePriceImpact.mockResolvedValue({
        success: false,
        error: 'Pool not found',
      });

      const result = (await calculatePriceImpactAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };
      expect(result.text).toContain('Error**: Pool not found');
    });

    it('should handle generic errors gracefully', async () => {
      (callLLMWithTimeout as vi.Mock).mockResolvedValue({
        inputTokenSymbolOrAddress: 'WMATIC',
        outputTokenSymbolOrAddress: 'USDC',
        inputAmount: '10',
      });
      (initializeQuickswapClient as vi.Mock).mockRejectedValue(new Error('Init failed'));

      const result = (await calculatePriceImpactAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };
      expect(result.text).toContain('Error**: Init failed');
    });
  });
});
