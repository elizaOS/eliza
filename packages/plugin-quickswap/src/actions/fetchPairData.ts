import { Action, IAgentRuntime, logger, Memory, composePromptFromState } from '@elizaos/core';
import { z } from 'zod';
import { callLLMWithTimeout } from '../utils/llmHelpers.js';
import { pairTemplate } from '../templates/pairTemplate.js';
import { initializeQuickswapClient } from '../utils/quickswapClient.js';

interface FetchPairDataParams {
  tokenASymbolOrAddress: string;
  tokenBSymbolOrAddress: string;
}

/**
 * M5-02: Fetches token pair data (e.g., liquidity, reserves, price) for a given pair of token symbols or addresses from Quickswap.
 */
export const fetchPairDataAction: Action = {
  name: 'QUICKSWAP_FETCH_PAIR_DATA',
  similes: [
    'GET_PAIR_INFO',
    'RETRIEVE_PAIR_DATA',
    'CHECK_PAIR_DETAILS',
    'PAIR_LOOKUP',
    'GET_LIQUIDITY_INFO',
  ].map((s) => `QUICKSWAP_${s}`),
  description:
    'Fetches comprehensive token pair data (e.g., liquidity, reserves, price) from Quickswap for a given pair of token symbols or addresses.',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info(`[fetchPairDataAction] Validate called for message: "${message.content?.text}"`);

    const quickswapApiUrl = runtime.getSetting('QUICKSWAP_API_URL');

    if (!quickswapApiUrl) {
      logger.warn('[fetchPairDataAction] QUICKSWAP_API_URL is required but not provided');
      return false;
    }

    // We'll rely more on LLM extraction for validation and graceful fallback in handler
    return true;
  },
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info(`[fetchPairDataAction] Handler called for message: "${message.content?.text}"`);

    let tokenASymbolOrAddress: string;
    let tokenBSymbolOrAddress: string;

    try {
      const llmResult = await callLLMWithTimeout<FetchPairDataParams & { error?: string }>(
        runtime,
        null,
        pairTemplate,
        'fetchPairDataAction',
        message.content?.text || ''
      );

      logger.info('[fetchPairDataAction] LLM result:', JSON.stringify(llmResult));

      if (
        llmResult?.error ||
        !llmResult?.tokenASymbolOrAddress ||
        !llmResult?.tokenBSymbolOrAddress
      ) {
        throw new Error('Required token pair parameters not found by LLM');
      }
      tokenASymbolOrAddress = llmResult.tokenASymbolOrAddress;
      tokenBSymbolOrAddress = llmResult.tokenBSymbolOrAddress;
    } catch (error) {
      logger.warn('[fetchPairDataAction] LLM extraction failed, trying regex fallback');

      const text = message.content?.text || '';
      const tokenMatches = text.match(/\b([a-zA-Z0-9]+)\b/gi); // Matches alphanumeric sequences
      if (tokenMatches && tokenMatches.length >= 2) {
        tokenASymbolOrAddress = tokenMatches[0];
        tokenBSymbolOrAddress = tokenMatches[1];
      } else {
        const errorMessage =
          'Please provide both token symbols or addresses for the pair (e.g., WMATIC and USDC).';
        logger.error(`[fetchPairDataAction] Parameter extraction failed: ${errorMessage}`);

        return {
          text: `❌ **Error**: ${errorMessage}\n\nExamples:\n• "What is the pair data for WMATIC and USDC?"\n• "Get liquidity info for DAI/ETH"\n• "Fetch pair details for 0x... (tokenA) and 0x... (tokenB)"\n\n**Required parameters:**\n- Token A Symbol or Address\n- Token B Symbol or Address`,
          actions: ['QUICKSWAP_FETCH_PAIR_DATA'],
          data: { error: errorMessage },
        };
      }
    }

    try {
      const quickswapClient = await initializeQuickswapClient(runtime);
      const pairData = await quickswapClient.fetchPairData(
        tokenASymbolOrAddress,
        tokenBSymbolOrAddress
      );

      if (pairData) {
        const responseText = `✅ **Pair Data Fetched Successfully**\n\n**Pair Details:**\n• **Token A**: ${pairData.tokenA.symbol} (${pairData.tokenA.address})\n• **Token B**: ${pairData.tokenB.symbol} (${pairData.tokenB.address})\n• **Liquidity**: ${pairData.liquidity}\n• **Reserves**: ${pairData.reserves}\n• **Price (A/B)**: ${pairData.priceAB}\n• **Price (B/A)**: ${pairData.priceBA}\n• **Source**: Quickswap`;

        return {
          text: responseText,
          actions: ['QUICKSWAP_FETCH_PAIR_DATA'],
          data: {
            success: true,
            pairDetails: pairData,
            timestamp: new Date().toISOString(),
          },
        };
      } else {
        const errorMessage = `Pair data for '${tokenASymbolOrAddress}/${tokenBSymbolOrAddress}' not found on Quickswap.`;
        return {
          text: `❌ **Error**: ${errorMessage}\n\nPlease verify the token symbols/addresses and try again.`,
          actions: ['QUICKSWAP_FETCH_PAIR_DATA'],
          data: {
            success: false,
            error: errorMessage,
            tokenASymbolOrAddress,
            tokenBSymbolOrAddress,
            timestamp: new Date().toISOString(),
          },
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred while fetching pair data';
      logger.error(`[fetchPairDataAction] Error fetching pair data:`, error);

      return {
        text: `❌ **Error**: ${errorMessage}\n\nPlease check your configuration and try again.`,
        actions: ['QUICKSWAP_FETCH_PAIR_DATA'],
        data: {
          error: errorMessage,
          tokenASymbolOrAddress,
          tokenBSymbolOrAddress,
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
          text: 'Get pair data for WMATIC and USDC via Quickswap',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching WMATIC/USDC pair data via Quickswap...',
          action: 'QUICKSWAP_FETCH_PAIR_DATA',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'What is the liquidity for DAI/ETH via Quickswap?',
        },
      },
      {
        name: '{{user2}} ',
        content: {
          text: 'Retrieving DAI/ETH liquidity information via Quickswap...',
          action: 'QUICKSWAP_FETCH_PAIR_DATA',
        },
      },
    ],
  ],
};
