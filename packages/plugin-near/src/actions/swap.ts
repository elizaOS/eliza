import {
  type ActionExample,
  type HandlerCallback,
  elizaLogger,
  type IAgentRuntime,
  type Memory,
  ModelClass,
  type State,
  type Action,
  composeContext,
  generateObject,
} from '@elizaos/core';
import { z } from 'zod';
import { walletProvider } from '../providers/wallet';
import { SwapService } from '../services/SwapService';
import { NearPluginError, formatErrorMessage, isNearError } from '../core/errors';
import type { SwapContent, SwapParams } from '../core/types';

export const SwapSchema = z.object({
  inputTokenId: z.string(),
  outputTokenId: z.string(),
  amount: z.string(),
});

const swapTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "inputTokenId": "wrap.testnet",
    "outputTokenId": "ref.fakes.testnet",
    "amount": "1.5"
}
\`\`\`

{{recentMessages}}

Given the recent messages and wallet information below:

{{walletInfo}}

Extract the following information about the requested token swap:
- Input token ID (the token being sold)
- Output token ID (the token being bought)
- Amount to swap

Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.`;

export const executeSwap: Action = {
  name: 'EXECUTE_SWAP_NEAR',
  similes: ['SWAP_TOKENS_NEAR', 'TOKEN_SWAP_NEAR', 'TRADE_TOKENS_NEAR', 'EXCHANGE_TOKENS_NEAR'],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => {
    return true;
  },
  description: 'Perform a token swap using Ref Finance on NEAR Protocol',
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<boolean> => {
    try {
      // Initialize or update state
      let currentState: State;

      if (!state) {
        currentState = (await runtime.composeState(message)) as State;
      } else {
        currentState = await runtime.updateRecentMessageState(state);
      }

      // Get wallet info for context
      const walletInfo = await walletProvider.get(runtime, message, currentState);
      currentState.walletInfo = walletInfo;

      // Compose swap context
      const swapContext = composeContext({
        state: currentState,
        template: swapTemplate,
      });

      // Generate swap parameters
      const generatedResult = await generateObject({
        runtime,
        context: swapContext,
        modelClass: ModelClass.LARGE,
        schema: SwapSchema,
      });

      const content = generatedResult.object as z.infer<typeof SwapSchema>;

      // Validate content
      if (!content || !content.inputTokenId || !content.outputTokenId || !content.amount) {
        elizaLogger.error('Missing required swap parameters');
        callback?.({
          text: 'I need to know which tokens to swap and the amount.',
          content: { error: 'Missing required parameters' },
        });
        return false;
      }

      // Get swap service
      const swapService = runtime.getService('near-swap' as any) as SwapService;

      if (!swapService) {
        throw new Error('Swap service not available');
      }

      // Get quote first
      elizaLogger.info(
        `Getting quote for swap: ${content.amount} ${content.inputTokenId} → ${content.outputTokenId}`
      );

      const params: SwapParams = {
        inputTokenId: content.inputTokenId,
        outputTokenId: content.outputTokenId,
        amount: content.amount,
      };

      const quote = await swapService.getQuote(params);

      // Check if price impact is acceptable
      if (quote.priceImpact > 0.05) {
        // 5% threshold
        callback?.({
          text: `Warning: This swap has high price impact (${(quote.priceImpact * 100).toFixed(2)}%). 
You'll receive approximately ${quote.route.outputAmount} ${quote.route.outputToken.symbol}.
Would you like to proceed?`,
          content: {
            quote,
            warning: 'high_price_impact',
          },
        });
        // In a real implementation, we'd wait for user confirmation
        return false;
      }

      // Execute swap
      elizaLogger.info(
        `Executing swap: ${content.amount} ${content.inputTokenId} → ${content.outputTokenId}`
      );

      const result = await swapService.executeSwap(params);

      // Send success response
      callback?.({
        text: `Successfully swapped ${content.amount} ${quote.route.inputToken.symbol} for ${quote.route.outputAmount} ${quote.route.outputToken.symbol}`,
        content: {
          success: true,
          transactionHash: result.transactionHash,
          explorerUrl: result.explorerUrl,
          input: {
            token: quote.route.inputToken.symbol,
            amount: content.amount,
          },
          output: {
            token: quote.route.outputToken.symbol,
            amount: quote.route.outputAmount,
          },
          priceImpact: quote.priceImpact,
          route: quote.route.route,
        },
      });

      return true;
    } catch (error) {
      elizaLogger.error('Error during token swap:', error);

      // Format error message
      let errorMessage = 'Error executing swap';
      if (isNearError(error)) {
        errorMessage = formatErrorMessage(error);
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }

      callback?.({
        text: errorMessage,
        content: {
          error: errorMessage,
          details: error,
        },
      });

      return false;
    }
  },
  examples: [
    [
      {
        user: '{{user1}}',
        content: {
          text: 'Swap 10 NEAR for USDC',
        },
      },
      {
        user: '{{agentName}}',
        content: {
          text: "I'll swap 10 NEAR for USDC...",
          action: 'EXECUTE_SWAP_NEAR',
        },
      },
      {
        user: '{{agentName}}',
        content: {
          text: 'Successfully swapped 10 NEAR for 245.67 USDC',
          content: {
            transactionHash: '8kL2m...',
            priceImpact: 0.003,
          },
        },
      },
    ],
    [
      {
        user: '{{user1}}',
        content: {
          text: 'Exchange 100 USDC for REF tokens',
        },
      },
      {
        user: '{{agentName}}',
        content: {
          text: "I'll exchange 100 USDC for REF tokens...",
          action: 'EXECUTE_SWAP_NEAR',
        },
      },
      {
        user: '{{agentName}}',
        content: {
          text: 'Successfully swapped 100 USDC for 1,234.56 REF',
          content: {
            route: ['usdc.fakes.testnet', 'wrap.testnet', 'ref.fakes.testnet'],
          },
        },
      },
    ],
  ] as ActionExample[][],
};
