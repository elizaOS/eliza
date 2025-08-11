import { Action, IAgentRuntime, logger, Memory, composePromptFromState } from '@elizaos/core';
import { z } from 'zod';
import { callLLMWithTimeout } from '../utils/llmHelpers.js';
import { estimateGasFeesTemplate } from '../templates/estimateGasFeesTemplate.js';
import { initializeQuickswapClient } from '../utils/quickswapClient.js';

interface EstimateGasFeesParams {
  transactionType: 'swap' | 'addLiquidity' | 'removeLiquidity' | 'approve';
  inputTokenSymbolOrAddress?: string;
  outputTokenSymbolOrAddress?: string;
  amount?: string;
}

/**
 * M5-17: Estimates the gas fees for a given type of transaction on Quickswap.
 */
export const estimateGasFeesAction: Action = {
  name: 'QUICKSWAP_ESTIMATE_GAS_FEES',
  similes: [
    'CHECK_TRANSACTION_COST',
    'GAS_PRICE_PREDICTION',
    'FEE_ESTIMATION',
    'TRANSACTION_FEES',
  ].map((s) => `QUICKSWAP_${s}`),
  description: 'Estimates the current gas fees for a specified type of transaction on Quickswap.',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info(`[estimateGasFeesAction] Validate called for message: "${message.content?.text}"`);

    const quickswapApiUrl = runtime.getSetting('QUICKSWAP_API_URL');

    if (!quickswapApiUrl) {
      logger.warn('[estimateGasFeesAction] QUICKSWAP_API_URL is required but not provided');
      return false;
    }

    return true;
  },
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info(`[estimateGasFeesAction] Handler called for message: "${message.content?.text}"`);

    let params: EstimateGasFeesParams;

    try {
      const llmResult = await callLLMWithTimeout<EstimateGasFeesParams & { error?: string }>(
        runtime,
        null,
        estimateGasFeesTemplate,
        'estimateGasFeesAction',
        message.content?.text || ''
      );

      logger.info('[estimateGasFeesAction] LLM result:', JSON.stringify(llmResult));

      if (llmResult?.error || !llmResult?.transactionType) {
        throw new Error('Required transaction type for gas estimation not found by LLM');
      }
      params = llmResult;
    } catch (error) {
      logger.warn('[estimateGasFeesAction] LLM extraction failed, trying regex fallback');

      const text = message.content?.text || '';
      const gasMatch = text.match(
        /(?:estimate|check)\s+gas\s+(?:fees|cost)\s+for\s+(swap|addLiquidity|removeLiquidity|approve)/i
      );
      const tokenInfoMatch = text.match(
        /(?:for)\s+(\d+\.?\d*)\s+([a-zA-Z0-9]+)\s+(?:to|with)\s+([a-zA-Z0-9]+)/i
      );

      if (gasMatch && gasMatch.length >= 2) {
        params = {
          transactionType: gasMatch[1] as 'swap' | 'addLiquidity' | 'removeLiquidity' | 'approve',
        };
        if (tokenInfoMatch && tokenInfoMatch.length >= 4) {
          params.amount = tokenInfoMatch[1];
          params.inputTokenSymbolOrAddress = tokenInfoMatch[2];
          params.outputTokenSymbolOrAddress = tokenInfoMatch[3];
        }
      } else {
        const errorMessage =
          'Please specify the transaction type for gas estimation (e.g., "estimate gas for a swap").';
        logger.error(`[estimateGasFeesAction] Parameter extraction failed`);
        return {
          text: `❌ **Error**: ${errorMessage}\n\nExamples:\n• "Estimate gas fees for a swap"\n• "How much gas will it cost to add liquidity?"\n• "What are the fees for approving USDC?"\n\n**Required parameters:**\n- Transaction Type (swap, addLiquidity, removeLiquidity, approve)\n- Optional: Input Token, Output Token, Amount (for more precise estimation)`,
          actions: ['QUICKSWAP_ESTIMATE_GAS_FEES'],
          data: { error: errorMessage },
        };
      }
    }

    try {
      const quickswapClient = await initializeQuickswapClient(runtime);
      const gasEstimateResult = await quickswapClient.estimateGasFees(params);

      if (gasEstimateResult && gasEstimateResult.success) {
        const responseText = `⛽ **Estimated Gas Fees for ${params.transactionType.toUpperCase()}**\n\n• **Fast**: ${gasEstimateResult.gasPriceGwei?.toFixed(2) || 'N/A'} Gwei (~${gasEstimateResult.feeInEth?.toFixed(6) || 'N/A'} ETH)\n• **Estimated Gas Use**: ${gasEstimateResult.estimatedGasUse || 'N/A'}\n• **Platform**: Polygon via Quickswap`;

        return {
          text: responseText,
          actions: ['QUICKSWAP_ESTIMATE_GAS_FEES'],
          data: {
            success: true,
            transactionType: params.transactionType,
            estimates: gasEstimateResult,
            timestamp: new Date().toISOString(),
          },
        };
      } else {
        const errorMessage = gasEstimateResult?.error || 'Failed to estimate gas fees.';
        return {
          text: `❌ **Error**: ${errorMessage}\n\nPlease verify transaction type and parameters and try again.`,
          actions: ['QUICKSWAP_ESTIMATE_GAS_FEES'],
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
        error instanceof Error ? error.message : 'Unknown error occurred while estimating gas fees';
      logger.error(`[estimateGasFeesAction] Error estimating gas fees:`, error);

      return {
        text: `❌ **Error**: ${errorMessage}\n\nPlease check your configuration and try again.`,
        actions: ['QUICKSWAP_ESTIMATE_GAS_FEES'],
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
          text: 'Estimate gas fees for a swap of 10 WMATIC to USDC via Quickswap',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Estimating gas via Quickswap...',
          action: 'QUICKSWAP_ESTIMATE_GAS_FEES',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'How much will it cost to add liquidity to the ETH-DAI pool via Quickswap?',
        },
      },
      {
        name: '{{user2}} ',
        content: {
          text: 'Estimating gas via Quickswap...',
          action: 'QUICKSWAP_ESTIMATE_GAS_FEES',
        },
      },
    ],
  ],
};
