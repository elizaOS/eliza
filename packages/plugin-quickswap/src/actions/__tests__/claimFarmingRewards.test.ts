import { vi, describe, it, expect, beforeEach } from 'vitest';
import { IAgentRuntime, Memory } from '@elizaos/core';
import { claimFarmingRewardsAction } from '../claimFarmingRewards.js';
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

describe('claimFarmingRewardsAction', () => {
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
        text: 'Claim my farming rewards',
        poolId: 'pool-123',
        walletAddress: '0x123...abc',
      },
    };
  });

  describe('validate', () => {
    it('should return false if QUICKSWAP_API_URL is not provided', async () => {
      (mockRuntime.getSetting as vi.Mock).mockReturnValue(undefined);
      const result = await claimFarmingRewardsAction.validate(mockRuntime, mockMemory);
      expect(result).toBe(false);
    });

    it('should return true if QUICKSWAP_API_URL is provided', async () => {
      (mockRuntime.getSetting as vi.Mock).mockReturnValue('http://fake-api-url.com');
      const result = await claimFarmingRewardsAction.validate(mockRuntime, mockMemory);
      expect(result).toBe(true);
    });
  });

  describe('handler', () => {
    const mockQuickswapClient = {
      claimFarmingRewards: vi.fn(),
    };

    beforeEach(() => {
      (initializeQuickswapClient as vi.Mock).mockResolvedValue(mockQuickswapClient);
      (mockRuntime.getSetting as vi.Mock).mockReturnValue('http://fake-api-url.com');
    });

    it('should call claimFarmingRewards and return success', async () => {
      const rewardResult = {
        success: true,
        rewardsClaimed: '150',
        rewardsTokenSymbol: 'QUICK',
        transactionHash: '0xjkl',
      };
      mockQuickswapClient.claimFarmingRewards.mockResolvedValue(rewardResult);

      const result = (await claimFarmingRewardsAction.handler(mockRuntime, mockMemory)) as {
        text: string;
        data: { success: boolean };
      };

      expect(initializeQuickswapClient).toHaveBeenCalledWith(mockRuntime);
      expect(mockQuickswapClient.claimFarmingRewards).toHaveBeenCalledWith({
        poolId: 'pool-123',
        walletAddress: '0x123...abc',
      });
      expect(result.text).toContain('Farming Rewards Claimed Successfully');
      expect(result.data?.success).toBe(true);
    });

    it('should return an error message on failed claim', async () => {
      const rewardResult = {
        success: false,
        error: 'No rewards to claim',
      };
      mockQuickswapClient.claimFarmingRewards.mockResolvedValue(rewardResult);

      const result = (await claimFarmingRewardsAction.handler(mockRuntime, mockMemory)) as {
        text: string;
        data: { success: boolean };
      };
      expect(result.text).toContain('Error**: No rewards to claim');
      expect(result.data?.success).toBe(false);
    });

    it('should handle Zod validation errors', async () => {
      mockMemory.content = { text: 'some text' }; // Missing params
      const result = (await claimFarmingRewardsAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };
      expect(result.text).toContain('Error**: Invalid parameters');
    });

    it('should handle generic errors', async () => {
      const error = new Error('Transaction failed');
      (initializeQuickswapClient as vi.Mock).mockRejectedValue(error);

      const result = (await claimFarmingRewardsAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };
      expect(result.text).toContain('Error**: Transaction failed');
    });
  });
});
