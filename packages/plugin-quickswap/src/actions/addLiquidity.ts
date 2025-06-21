import { Action, IAgentRuntime, logger, Memory } from '@elizaos/core';
import { initializeQuickswapClient } from '../utils/quickswapClient.js';
import { z } from 'zod';

/**
 * M5-04: Adds liquidity to a Quickswap pool.
 */
export const addLiquidityAction: Action = {
  name: 'QUICKSWAP_ADD_LIQUIDITY',
  description: 'Adds liquidity for a specified token pair to a Quickswap pool.',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info(`[addLiquidityAction] Validate called for message: "${message.content?.text}"`);

    const quickswapApiUrl = runtime.getSetting('QUICKSWAP_API_URL');

    if (!quickswapApiUrl) {
      logger.warn('[addLiquidityAction] QUICKSWAP_API_URL is required but not provided');
      return false;
    }
    logger.info('[addLiquidityAction] Validation passed');
    return true;
  },
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    try {
      const parsedParams = z
        .object({
          token0SymbolOrAddress: z.string().describe('The symbol or address of the first token.'),
          token1SymbolOrAddress: z.string().describe('The symbol or address of the second token.'),
          amount0: z.string().describe('The amount of the first token to add.'),
          amount1: z.string().describe('The amount of the second token to add.'),
        })
        .parse(message.content);

      const { token0SymbolOrAddress, token1SymbolOrAddress, amount0, amount1 } = parsedParams;

      // Parse amounts to numbers
      const parsedAmount0 = parseFloat(amount0);
      const parsedAmount1 = parseFloat(amount1);
      if (
        isNaN(parsedAmount0) ||
        isNaN(parsedAmount1) ||
        parsedAmount0 <= 0 ||
        parsedAmount1 <= 0
      ) {
        return {
          text: '❌ **Error**: Invalid amounts. Please provide positive numbers for both tokens.',
          actions: ['QUICKSWAP_ADD_LIQUIDITY'],
        };
      }

      // Initialize Quickswap client
      const quickswapClient = await initializeQuickswapClient(runtime);

      // Execute add liquidity logic using the client
      const addLiquidityResult = await quickswapClient.AddLiquidity(
        token0SymbolOrAddress,
        token1SymbolOrAddress,
        parsedAmount0,
        parsedAmount1
      );

      if (addLiquidityResult.success) {
        const responseText = `✅ **Liquidity Added Successfully**\n\n**Liquidity Details:**\n• **Token 0**: ${token0SymbolOrAddress.toUpperCase()}\n• **Token 1**: ${token1SymbolOrAddress.toUpperCase()}\n• **Amount 0**: ${amount0}\n• **Amount 1**: ${amount1}\n• **LP Tokens Received**: ${addLiquidityResult.lpTokensReceived}\n• **Transaction Hash**: ${addLiquidityResult.transactionHash}`;
        return {
          text: responseText,
          actions: ['QUICKSWAP_ADD_LIQUIDITY'],
          data: {
            success: true,
            addLiquidityDetails: addLiquidityResult,
            timestamp: new Date().toISOString(),
          },
        };
      } else {
        return {
          text: `❌ **Error**: ${addLiquidityResult.error || 'Failed to add liquidity.'}`,
          actions: ['QUICKSWAP_ADD_LIQUIDITY'],
          data: {
            success: false,
            error: addLiquidityResult.error,
            token0SymbolOrAddress,
            token1SymbolOrAddress,
            amount0,
            amount1,
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
            : 'Unknown error occurred while adding liquidity';
      logger.error(`[addLiquidityAction] Error adding liquidity:`, error);
      return {
        text: `❌ **Error**: ${errorMessage}`,
        actions: ['QUICKSWAP_ADD_LIQUIDITY'],
        data: {
          error: errorMessage,
          timestamp: new Date().toISOString(),
        },
      };
    }
  },
};
