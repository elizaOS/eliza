import { Action, IAgentRuntime, logger, Memory } from '@elizaos/core';
import { initializeQuickswapClient } from '../utils/quickswapClient.js';
import { z } from 'zod';

/**
 * M5-03: Swaps tokens on Quickswap.
 */
export const swapTokensAction: Action = {
  name: 'QUICKSWAP_SWAP_TOKENS',
  description: 'Swaps a specified amount of an input token for an output token on Quickswap.',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info(`[swapTokensAction] Validate called for message: "${message.content?.text}"`);

    const quickswapApiUrl = runtime.getSetting('QUICKSWAP_API_URL');

    if (!quickswapApiUrl) {
      logger.warn('[swapTokensAction] QUICKSWAP_API_URL is required but not provided');
      return false;
    }

    logger.info('[swapTokensAction] Validation passed');
    return true;
  },
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    try {
      const parsedParams = z
        .object({
          inputTokenSymbolOrAddress: z
            .string()
            .describe('The symbol or address of the input token (e.g., WMATIC, USDC, 0x...).'),
          outputTokenSymbolOrAddress: z
            .string()
            .describe('The symbol or address of the output token (e.g., WMATIC, USDC, 0x...).'),
          amount: z.string().describe('The amount of input token to swap.'),
        })
        .parse(message.content);

      const { inputTokenSymbolOrAddress, outputTokenSymbolOrAddress, amount } = parsedParams;

      // Parse amount to number
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return {
          text: '❌ **Error**: Invalid amount. Please provide a positive number.',
          actions: ['QUICKSWAP_SWAP_TOKENS'],
        };
      }

      // Initialize Quickswap client
      const quickswapClient = await initializeQuickswapClient(runtime);

      // Execute swap logic using the client
      const swapResult = await quickswapClient.Swap(
        inputTokenSymbolOrAddress,
        outputTokenSymbolOrAddress,
        parsedAmount
      );

      if (swapResult.success) {
        const responseText = `✅ **Swap Executed Successfully**\n\n**Swap Details:**\n• **Input Token**: ${inputTokenSymbolOrAddress.toUpperCase()}\n• **Output Token**: ${outputTokenSymbolOrAddress.toUpperCase()}\n• **Amount Swapped**: ${amount}\n• **Amount Received**: ${swapResult.amountReceived}\n• **Transaction Hash**: ${swapResult.transactionHash}`;
        return {
          text: responseText,
          actions: ['QUICKSWAP_SWAP_TOKENS'],
          data: {
            success: true,
            swapDetails: swapResult,
            timestamp: new Date().toISOString(),
          },
        };
      } else {
        return {
          text: `❌ **Error**: ${swapResult.error || 'Failed to execute swap.'}`,
          actions: ['QUICKSWAP_SWAP_TOKENS'],
          data: {
            success: false,
            error: swapResult.error,
            inputTokenSymbolOrAddress,
            outputTokenSymbolOrAddress,
            amount,
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
            : 'Unknown error occurred while executing swap';
      logger.error(`[swapTokensAction] Error executing swap:`, error);
      return {
        text: `❌ **Error**: ${errorMessage}`,
        actions: ['QUICKSWAP_SWAP_TOKENS'],
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
          text: 'Swap 10 USDC for WMATIC via Quickswap',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Attempting to swap 10 USDC for WMATIC via Quickswap...',
          action: 'QUICKSWAP_SWAP_TOKENS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'I want to exchange 5 WMATIC for DAI via Quickswap, with at least 4.9 DAI',
        },
      },
      {
        name: '{{user2}} ',
        content: {
          text: 'Processing your exchange for 5 WMATIC for DAI via Quickswap...',
          action: 'QUICKSWAP_SWAP_TOKENS',
        },
      },
    ],
  ],
};
