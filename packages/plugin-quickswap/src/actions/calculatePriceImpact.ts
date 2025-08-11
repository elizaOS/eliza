import { Action, IAgentRuntime, logger, Memory, composePromptFromState } from '@elizaos/core';
import { z } from 'zod';
import { callLLMWithTimeout } from '../utils/llmHelpers.js';
import { calculatePriceImpactTemplate } from '../templates/calculatePriceImpactTemplate.js';
import { initializeQuickswapClient } from '../utils/quickswapClient.js';

interface CalculatePriceImpactParams {
  inputTokenSymbolOrAddress: string;
  outputTokenSymbolOrAddress: string;
  inputAmount: string;
}

/**
 * M5-12: Calculates the estimated price impact for a given trade on Quickswap.
 */
export const calculatePriceImpactAction: Action = {
  name: 'QUICKSWAP_CALCULATE_PRICE_IMPACT',
  similes: ['ESTIMATE_SLIPPAGE', 'PRICE_IMPACT_CHECK', 'TRADE_COST_ANALYSIS', 'SWAP_IMPACT'].map(
    (s) => `QUICKSWAP_${s}`
  ),
  description: 'Calculates the potential price impact for a swap between two tokens on Quickswap.',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info(
      `[calculatePriceImpactAction] Validate called for message: "${message.content?.text}"`
    );

    const quickswapApiUrl = runtime.getSetting('QUICKSWAP_API_URL');

    if (!quickswapApiUrl) {
      logger.warn('[calculatePriceImpactAction] QUICKSWAP_API_URL is required but not provided');
      return false;
    }

    return true;
  },
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info(
      `[calculatePriceImpactAction] Handler called for message: "${message.content?.text}"`
    );

    let params: CalculatePriceImpactParams;

    try {
      const llmResult = await callLLMWithTimeout<CalculatePriceImpactParams & { error?: string }>(
        runtime,
        null,
        calculatePriceImpactTemplate,
        'calculatePriceImpactAction',
        message.content?.text || ''
      );

      logger.info('[calculatePriceImpactAction] LLM result:', JSON.stringify(llmResult));

      if (
        llmResult?.error ||
        !llmResult?.inputTokenSymbolOrAddress ||
        !llmResult?.outputTokenSymbolOrAddress ||
        !llmResult?.inputAmount
      ) {
        throw new Error('Required price impact parameters not found by LLM');
      }
      params = llmResult;
    } catch (error) {
      logger.warn('[calculatePriceImpactAction] LLM extraction failed, trying regex fallback');

      const text = message.content?.text || '';
      const priceImpactMatch = text.match(
        /price\s+impact\s+for\s+(\d+\.?\d*)\s+([a-zA-Z0-9]+)\s+to\s+([a-zA-Z0-9]+)/i
      );

      if (priceImpactMatch && priceImpactMatch.length >= 4) {
        params = {
          inputAmount: priceImpactMatch[1],
          inputTokenSymbolOrAddress: priceImpactMatch[2],
          outputTokenSymbolOrAddress: priceImpactMatch[3],
        };
      } else {
        const errorMessage =
          'Please specify the input amount, input token, and output token (e.g., "calculate price impact for 10 WMATIC to USDC").';
        logger.error(`[calculatePriceImpactAction] Parameter extraction failed`);
        return {
          text: `❌ **Error**: ${errorMessage}\n\nExamples:\n• "Calculate price impact for 10 WMATIC to USDC"
• "What is the price impact if I swap 5 ETH for DAI?"

**Required parameters:**
- Input Token Symbol/Address
- Output Token Symbol/Address
- Input Amount`,
          actions: ['QUICKSWAP_CALCULATE_PRICE_IMPACT'],
          data: { error: errorMessage },
        };
      }
    }

    try {
      const quickswapClient = await initializeQuickswapClient(runtime);
      const priceImpactResult = await quickswapClient.calculatePriceImpact(
        params.inputTokenSymbolOrAddress,
        params.outputTokenSymbolOrAddress,
        parseFloat(params.inputAmount)
      );

      if (priceImpactResult && priceImpactResult.success) {
        const responseText = `📈 **Price Impact Calculation for ${params.inputAmount} ${params.inputTokenSymbolOrAddress.toUpperCase()} to ${params.outputTokenSymbolOrAddress.toUpperCase()}**\n\n• **Estimated Price Impact**: ${priceImpactResult.priceImpactPercentage}%\n• **New Price**: ${priceImpactResult.newPrice} ${params.outputTokenSymbolOrAddress.toUpperCase()}/${params.inputTokenSymbolOrAddress.toUpperCase()}\n• **Platform**: Quickswap`;

        return {
          text: responseText,
          actions: ['QUICKSWAP_CALCULATE_PRICE_IMPACT'],
          data: {
            success: true,
            inputToken: params.inputTokenSymbolOrAddress,
            outputToken: params.outputTokenSymbolOrAddress,
            inputAmount: params.inputAmount,
            priceImpactPercentage: priceImpactResult.priceImpactPercentage,
            newPrice: priceImpactResult.newPrice,
            timestamp: new Date().toISOString(),
          },
        };
      } else {
        const errorMessage = priceImpactResult?.error || 'Failed to calculate price impact.';
        return {
          text: `❌ **Error**: ${errorMessage}\n\nPlease verify token pair and amount and try again.`,
          actions: ['QUICKSWAP_CALCULATE_PRICE_IMPACT'],
          data: {
            success: false,
            error: errorMessage,
            params,
            timestamp: new Date().toISOString(),
          },
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Unknown error occurred while calculating price impact';
      logger.error(`[calculatePriceImpactAction] Error calculating price impact:`, error);

      return {
        text: `❌ **Error**: ${errorMessage}\n\nPlease check your configuration and try again.`,
        actions: ['QUICKSWAP_CALCULATE_PRICE_IMPACT'],
        data: {
          error: errorMessage,
          params,
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
          text: 'Calculate price impact for 10 WMATIC to USDC via Quickswap',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Calculating price impact via Quickswap...',
          action: 'QUICKSWAP_CALCULATE_PRICE_IMPACT',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'What is the price impact if I swap 5 ETH for DAI via Quickswap?',
        },
      },
      {
        name: '{{user2}} ',
        content: {
          text: 'Calculating price impact via Quickswap...',
          action: 'QUICKSWAP_CALCULATE_PRICE_IMPACT',
        },
      },
    ],
  ],
};
