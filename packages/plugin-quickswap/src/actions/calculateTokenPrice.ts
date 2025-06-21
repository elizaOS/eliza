import { Action, IAgentRuntime, logger, Memory } from '@elizaos/core';
import { initializeQuickswapClient } from '../utils/quickswapClient.js';
import { z } from 'zod';

/**
 * M5-09: Calculates the price of a token against another token in a Quickswap pool.
 */
export const calculateTokenPriceAction: Action = {
  name: 'QUICKSWAP_CALCULATE_TOKEN_PRICE',
  description: 'Calculates the price of a given token against another token on Quickswap.',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info(
      `[calculateTokenPriceAction] Validate called for message: "${message.content?.text}"`
    );

    const quickswapApiUrl = runtime.getSetting('QUICKSWAP_API_URL');

    if (!quickswapApiUrl) {
      logger.warn('[calculateTokenPriceAction] QUICKSWAP_API_URL is required but not provided');
      return false;
    }

    logger.info('[calculateTokenPriceAction] Validation passed');
    return true;
  },
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    try {
      const parsedParams = z
        .object({
          tokenSymbolOrAddress: z
            .string()
            .describe('The symbol or address of the token to calculate price for.'),
          vsTokenSymbolOrAddress: z
            .string()
            .describe('The symbol or address of the token to calculate price against.'),
        })
        .parse(message.content);

      const { tokenSymbolOrAddress, vsTokenSymbolOrAddress } = parsedParams;

      // Initialize Quickswap client
      const quickswapClient = await initializeQuickswapClient(runtime);

      // Execute calculate token price logic
      const tokenPriceResult = await quickswapClient.CalculateTokenPrice(
        tokenSymbolOrAddress,
        vsTokenSymbolOrAddress
      );

      if (tokenPriceResult.success) {
        const responseText = `✅ **Token Price Calculated**\n\n**Price Details:**\n• **Token**: ${tokenSymbolOrAddress.toUpperCase()}\n• **Vs Token**: ${vsTokenSymbolOrAddress.toUpperCase()}\n• **Price**: ${tokenPriceResult.price}`;
        return {
          text: responseText,
          actions: ['calculateTokenPrice'],
          data: {
            success: true,
            price: tokenPriceResult.price,
            timestamp: new Date().toISOString(),
          },
        };
      } else {
        return {
          text: `❌ **Error**: ${tokenPriceResult.error || 'Failed to calculate token price.'}`,
          actions: ['calculateTokenPrice'],
          data: {
            success: false,
            error: tokenPriceResult.error,
            tokenSymbolOrAddress,
            vsTokenSymbolOrAddress,
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
            : 'Unknown error occurred while calculating token price';
      logger.error(`[calculateTokenPriceAction] Error calculating token price:`, error);
      return {
        text: `❌ **Error**: ${errorMessage}`,
        actions: ['calculateTokenPrice'],
        data: {
          error: errorMessage,
          timestamp: new Date().toISOString(),
        },
      };
    }
  },
};
