import { vi, describe, it, expect, beforeEach } from 'vitest';
import { IAgentRuntime, Memory } from '@elizaos/core';
import { getFarmingPoolDetailsAction } from '../getFarmingPoolDetails.js';
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

describe('getFarmingPoolDetailsAction', () => {
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
        text: 'Get details for a farming pool',
        poolId: 'pool-456',
      },
    };
  });

  describe('validate', () => {
    it('should return false if QUICKSWAP_API_URL is not provided', async () => {
      (mockRuntime.getSetting as vi.Mock).mockReturnValue(undefined);
      const result = await getFarmingPoolDetailsAction.validate(mockRuntime, mockMemory);
      expect(result).toBe(false);
    });

    it('should return true if QUICKSWAP_API_URL is provided', async () => {
      (mockRuntime.getSetting as vi.Mock).mockReturnValue('http://fake-api-url.com');
      const result = await getFarmingPoolDetailsAction.validate(mockRuntime, mockMemory);
      expect(result).toBe(true);
    });
  });

  describe('handler', () => {
    const mockQuickswapClient = {
      getFarmingPoolDetails: vi.fn(),
    };

    beforeEach(() => {
      (initializeQuickswapClient as vi.Mock).mockResolvedValue(mockQuickswapClient);
      (mockRuntime.getSetting as vi.Mock).mockReturnValue('http://fake-api-url.com');
    });

    it('should call getFarmingPoolDetails with poolId and return success', async () => {
      const poolDetails = {
        success: true,
        poolId: 'pool-456',
        name: 'WMATIC/USDC',
        apr: 0.12,
        totalStaked: '1000000',
        rewardTokenSymbol: 'QUICK',
      };
      mockQuickswapClient.getFarmingPoolDetails.mockResolvedValue(poolDetails);

      const result = (await getFarmingPoolDetailsAction.handler(mockRuntime, mockMemory)) as {
        text: string;
        data: { success: boolean };
      };

      expect(mockQuickswapClient.getFarmingPoolDetails).toHaveBeenCalledWith({
        poolId: 'pool-456',
        token0SymbolOrAddress: undefined,
        token1SymbolOrAddress: undefined,
      });
      expect(result.text).toContain('Farming Pool Details');
      expect(result.data?.success).toBe(true);
    });

    it('should call getFarmingPoolDetails with token pair and return success', async () => {
      mockMemory.content = {
        text: 'details for WETH/DAI',
        token0SymbolOrAddress: 'WETH',
        token1SymbolOrAddress: 'DAI',
      };
      const poolDetails = {
        success: true,
        poolId: 'pool-789',
        name: 'WETH/DAI',
        apr: 0.08,
        totalStaked: '500000',
        rewardTokenSymbol: 'QUICK',
      };
      mockQuickswapClient.getFarmingPoolDetails.mockResolvedValue(poolDetails);

      const result = (await getFarmingPoolDetailsAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };

      expect(mockQuickswapClient.getFarmingPoolDetails).toHaveBeenCalledWith({
        poolId: undefined,
        token0SymbolOrAddress: 'WETH',
        token1SymbolOrAddress: 'DAI',
      });
      expect(result.text).toContain('Farming Pool Details');
    });

    it('should return an error message on failed retrieval', async () => {
      const poolDetails = { success: false, error: 'Pool not found' };
      mockQuickswapClient.getFarmingPoolDetails.mockResolvedValue(poolDetails);

      const result = (await getFarmingPoolDetailsAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };
      expect(result.text).toContain('Error**: Pool not found');
    });

    it('should handle Zod validation errors for insufficient params', async () => {
      mockMemory.content = { text: 'details please' }; // Missing params
      const result = (await getFarmingPoolDetailsAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };
      expect(result.text).toContain('Error**: Invalid parameters');
    });
  });
});
