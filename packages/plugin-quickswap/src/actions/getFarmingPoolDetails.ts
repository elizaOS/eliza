import { Action, IAgentRuntime, logger, Memory } from '@elizaos/core';
import { initializeQuickswapClient } from '../utils/quickswapClient.js';
import { z } from 'zod';

/**
 * M5-14: Retrieves details of a Quickswap farming pool.
 */
export const getFarmingPoolDetailsAction: Action = {
  name: 'QUICKSWAP_GET_FARMING_POOL_DETAILS',
  description:
    'Retrieves details of a specific Quickswap farming pool by its ID or by the token pair it holds.',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info(
      `[getFarmingPoolDetailsAction] Validate called for message: "${message.content?.text}"`
    );

    const quickswapApiUrl = runtime.getSetting('QUICKSWAP_API_URL');

    if (!quickswapApiUrl) {
      logger.warn('[getFarmingPoolDetailsAction] QUICKSWAP_API_URL is required but not provided');
      return false;
    }

    logger.info('[getFarmingPoolDetailsAction] Validation passed');
    return true;
  },
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    try {
      const parsedParams = z
        .object({
          poolId: z.string().optional().describe('The ID of the farming pool.'),
          token0SymbolOrAddress: z
            .string()
            .optional()
            .describe(
              'The symbol or address of the first token in the pool (e.g., WMATIC, USDC, 0x...).'
            ),
          token1SymbolOrAddress: z
            .string()
            .optional()
            .describe(
              'The symbol or address of the second token in the pool (e.g., WMATIC, USDC, 0x...).'
            ),
        })
        .refine(
          (data) => data.poolId || (data.token0SymbolOrAddress && data.token1SymbolOrAddress),
          {
            message:
              'Either poolId or both token0SymbolOrAddress and token1SymbolOrAddress must be provided.',
          }
        )
        .parse(message.content);

      const { poolId, token0SymbolOrAddress, token1SymbolOrAddress } = parsedParams;

      // Initialize Quickswap client
      const quickswapClient = await initializeQuickswapClient(runtime);

      // Execute get farming pool details logic
      const poolDetailsResult = await quickswapClient.getFarmingPoolDetails({
        poolId,
        token0SymbolOrAddress,
        token1SymbolOrAddress,
      });

      if (poolDetailsResult.success) {
        const responseText = `✅ **Farming Pool Details**\n\n**Details:**\n• **Pool ID**: ${poolDetailsResult.poolId || 'N/A'}\n• **Name**: ${poolDetailsResult.name || 'N/A'}\n• **APR**: ${(poolDetailsResult.apr * 100).toFixed(2)}%\n• **Total Staked**: ${poolDetailsResult.totalStaked || 'N/A'}\n• **Reward Token**: ${poolDetailsResult.rewardTokenSymbol || 'N/A'}`;
        return {
          text: responseText,
          actions: ['getFarmingPoolDetails'],
          data: {
            success: true,
            poolDetails: poolDetailsResult,
            timestamp: new Date().toISOString(),
          },
        };
      } else {
        return {
          text: `❌ **Error**: ${poolDetailsResult.error || 'Failed to retrieve farming pool details.'}`,
          actions: ['getFarmingPoolDetails'],
          data: {
            success: false,
            error: poolDetailsResult.error,
            poolId,
            token0SymbolOrAddress,
            token1SymbolOrAddress,
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
            : 'Unknown error occurred while retrieving farming pool details';
      logger.error(`[getFarmingPoolDetailsAction] Error retrieving farming pool details:`, error);
      return {
        text: `❌ **Error**: ${errorMessage}`,
        actions: ['getFarmingPoolDetails'],
        data: {
          error: errorMessage,
          timestamp: new Date().toISOString(),
        },
      };
    }
  },
};
