import { Action, IAgentRuntime, logger, Memory } from '@elizaos/core';
import { initializeQuickswapClient } from '../utils/quickswapClient.js';
import { z } from 'zod';

/**
 * M5-15: Claims farming rewards from a Quickswap pool.
 */
export const claimFarmingRewardsAction: Action = {
  name: 'QUICKSWAP_CLAIM_FARMING_REWARDS',
  description: 'Claims farming rewards for a given wallet from a specified Quickswap farming pool.',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info(
      `[claimFarmingRewardsAction] Validate called for message: "${message.content?.text}"`
    );

    const quickswapApiUrl = runtime.getSetting('QUICKSWAP_API_URL');

    if (!quickswapApiUrl) {
      logger.warn('[claimFarmingRewardsAction] QUICKSWAP_API_URL is required but not provided');
      return false;
    }

    logger.info('[claimFarmingRewardsAction] Validation passed');
    return true;
  },
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    try {
      const parsedParams = z
        .object({
          poolId: z.string().describe('The ID of the farming pool.'),
          walletAddress: z.string().describe('The wallet address to claim rewards for.'),
        })
        .parse(message.content);

      const { poolId, walletAddress } = parsedParams;

      // Initialize Quickswap client
      const quickswapClient = await initializeQuickswapClient(runtime);

      // Execute claim farming rewards logic
      const rewardsResult = await quickswapClient.claimFarmingRewards({
        poolId,
        walletAddress,
      });

      if (rewardsResult.success) {
        const responseText = `✅ **Farming Rewards Claimed Successfully**\n\n**Details:**\n• **Pool ID**: ${poolId}\n• **Wallet Address**: ${walletAddress}\n• **Rewards Claimed**: ${rewardsResult.rewardsClaimed} ${rewardsResult.rewardsTokenSymbol}\n• **Transaction Hash**: ${rewardsResult.transactionHash}`;
        return {
          text: responseText,
          actions: ['claimFarmingRewards'],
          data: {
            success: true,
            rewardsDetails: rewardsResult,
            timestamp: new Date().toISOString(),
          },
        };
      } else {
        return {
          text: `❌ **Error**: ${rewardsResult.error || 'Failed to claim farming rewards.'}`,
          actions: ['claimFarmingRewards'],
          data: {
            success: false,
            error: rewardsResult.error,
            poolId,
            walletAddress,
            timestamp: new Date().toISOString(),
          },
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof z.ZodError
          ? `Invalid parameters: ${error.errors.map((e) => e.message).join(', ')}`
          : error instanceof Error
            ? error.message
            : 'Unknown error occurred while claiming farming rewards';
      logger.error(`[claimFarmingRewardsAction] Error claiming farming rewards:`, error);
      return {
        text: `❌ **Error**: ${errorMessage}`,
        actions: ['claimFarmingRewards'],
        data: {
          error: errorMessage,
          timestamp: new Date().toISOString(),
        },
      };
    }
  },
};
