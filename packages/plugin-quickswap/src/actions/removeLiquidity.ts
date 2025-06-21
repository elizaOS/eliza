import { Action, IAgentRuntime, logger, Memory } from '@elizaos/core';
import { initializeQuickswapClient } from '../utils/quickswapClient.js';
import { z } from 'zod';

/**
 * M5-05: Removes liquidity from a Quickswap pool.
 */
export const removeLiquidityAction: Action = {
  name: 'QUICKSWAP_REMOVE_LIQUIDITY',
  description:
    'Removes a specified amount of liquidity (LP tokens) from a Quickswap pool and receives back the underlying tokens.',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info(`[removeLiquidityAction] Validate called for message: "${message.content?.text}"`);

    const quickswapApiUrl = runtime.getSetting('QUICKSWAP_API_URL');

    if (!quickswapApiUrl) {
      logger.warn('[removeLiquidityAction] QUICKSWAP_API_URL is required but not provided');
      return false;
    }

    logger.info('[removeLiquidityAction] Validation passed');
    return true;
  },
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    try {
      const parsedParams = z
        .object({
          token0SymbolOrAddress: z.string().describe('The symbol or address of the first token.'),
          token1SymbolOrAddress: z.string().describe('The symbol or address of the second token.'),
          lpTokensAmount: z.string().describe('The amount of LP tokens to remove.'),
        })
        .parse(message.content);

      const { token0SymbolOrAddress, token1SymbolOrAddress, lpTokensAmount } = parsedParams;

      // Parse LP token amount to number
      const parsedLpTokensAmount = parseFloat(lpTokensAmount);
      if (isNaN(parsedLpTokensAmount) || parsedLpTokensAmount <= 0) {
        return {
          text: '❌ **Error**: Invalid LP token amount. Please provide a positive number.',
          actions: ['QUICKSWAP_REMOVE_LIQUIDITY'],
        };
      }

      // Initialize Quickswap client
      const quickswapClient = await initializeQuickswapClient(runtime);

      // Execute remove liquidity logic using the client
      const removeLiquidityResult = await quickswapClient.RemoveLiquidity(
        token0SymbolOrAddress,
        token1SymbolOrAddress,
        parsedLpTokensAmount
      );

      if (removeLiquidityResult.success) {
        const responseText = `✅ **Liquidity Removed Successfully**\n\n**Liquidity Details:**\n• **Token 0**: ${token0SymbolOrAddress.toUpperCase()}\n• **Token 1**: ${token1SymbolOrAddress.toUpperCase()}\n• **LP Tokens Removed**: ${lpTokensAmount}\n• **Token 0 Received**: ${removeLiquidityResult.token0Received}\n• **Token 1 Received**: ${removeLiquidityResult.token1Received}\n• **Transaction Hash**: ${removeLiquidityResult.transactionHash}`;
        return {
          text: responseText,
          actions: ['QUICKSWAP_REMOVE_LIQUIDITY'],
          data: {
            success: true,
            removeLiquidityDetails: removeLiquidityResult,
            timestamp: new Date().toISOString(),
          },
        };
      } else {
        return {
          text: `❌ **Error**: ${removeLiquidityResult.error || 'Failed to remove liquidity.'}`,
          actions: ['QUICKSWAP_REMOVE_LIQUIDITY'],
          data: {
            success: false,
            error: removeLiquidityResult.error,
            token0SymbolOrAddress,
            token1SymbolOrAddress,
            lpTokensAmount,
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
            : 'Unknown error occurred while removing liquidity';
      logger.error(`[removeLiquidityAction] Error removing liquidity:`, error);
      return {
        text: `❌ **Error**: ${errorMessage}`,
        actions: ['QUICKSWAP_REMOVE_LIQUIDITY'],
        data: {
          error: errorMessage,
          timestamp: new Date().toISOString(),
        },
      };
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Remove 10 LP tokens from USDC/WMATIC pool via Quickswap',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Attempting to remove liquidity for USDC/WMATIC via Quickswap...',
          action: 'QUICKSWAP_REMOVE_LIQUIDITY',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Withdraw 5 LP tokens from WETH-DAI via Quickswap',
        },
      },
      {
        name: '{{user2}} ',
        content: {
          text: 'Processing your liquidity withdrawal via Quickswap...',
          action: 'QUICKSWAP_REMOVE_LIQUIDITY',
        },
      },
    ],
  ],
};
