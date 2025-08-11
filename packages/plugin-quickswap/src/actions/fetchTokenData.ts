import { Action, IAgentRuntime, logger, Memory, composePromptFromState } from '@elizaos/core';
import { z } from 'zod';
import { callLLMWithTimeout } from '../utils/llmHelpers.js';
import { tokenTemplate } from '../templates/tokenTemplate.js';
import { initializeQuickswapClient } from '../utils/quickswapClient.js';

interface FetchTokenDataParams {
  tokenSymbolOrAddress: string;
}

/**
 * M5-01: Fetches token data for a given token symbol or address from Quickswap.
 */
export const fetchTokenDataAction: Action = {
  name: 'QUICKSWAP_FETCH_TOKEN_DATA',
  similes: [
    'GET_TOKEN_INFO',
    'RETRIEVE_TOKEN_DATA',
    'CHECK_TOKEN_DETAILS',
    'TOKEN_LOOKUP',
    'GET_CRYPTO_INFO',
  ].map((s) => `QUICKSWAP_${s}`),
  description:
    'Fetches comprehensive token data (name, symbol, decimals, address) from Quickswap for a given token symbol or address.',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info(`[fetchTokenDataAction] Validate called for message: "${message.content?.text}"`);

    const quickswapApiUrl = runtime.getSetting('QUICKSWAP_API_URL');

    if (!quickswapApiUrl) {
      logger.warn('[fetchTokenDataAction] QUICKSWAP_API_URL is required but not provided');
      return false;
    }

    // We'll rely more on LLM extraction for validation and graceful fallback in handler
    return true; // Always return true for initial validation and let handler extract parameters
  },
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info(`[fetchTokenDataAction] Handler called for message: "${message.content?.text}"`);

    let tokenSymbolOrAddress: string;

    try {
      // Use LLM to extract parameters
      const llmResult = await callLLMWithTimeout<FetchTokenDataParams & { error?: string }>(
        runtime,
        null, // State is not directly used for parameter extraction, LLM operates on message
        tokenTemplate,
        'fetchTokenDataAction',
        message.content?.text || '' // Pass the message text to the LLM
      );

      logger.info('[fetchTokenDataAction] LLM result:', JSON.stringify(llmResult));

      if (llmResult?.error || !llmResult?.tokenSymbolOrAddress) {
        throw new Error('Required token parameter not found by LLM');
      }
      tokenSymbolOrAddress = llmResult.tokenSymbolOrAddress;
    } catch (error) {
      logger.warn('[fetchTokenDataAction] LLM extraction failed, trying regex fallback');

      // Fallback to regex extraction
      const text = message.content?.text || '';

      // Extract token symbol or address (simple regex for demonstration)
      const tokenMatch = text.match(/\b([a-zA-Z0-9]+)\b/i); // Matches alphanumeric sequences
      tokenSymbolOrAddress = tokenMatch?.[1] || '';

      if (!tokenSymbolOrAddress) {
        const errorMessage =
          'Please provide a token symbol or address (e.g., USDC, WMATIC, or a full contract address).';
        logger.error(`[fetchTokenDataAction] Parameter extraction failed`);

        return {
          text: `❌ **Error**: ${errorMessage}\n\nExamples:\n• "What is the data for USDC?"\n• "Get details for WMATIC"\n• "Fetch token info for 0x2791B072600277340f1aDa76aE19A6C09bED2737"\n\n**Required parameters:**\n- Token Symbol or Address`,
          actions: ['QUICKSWAP_FETCH_TOKEN_DATA'],
          data: { error: errorMessage },
        };
      }
    }

    try {
      const quickswapClient = await initializeQuickswapClient(runtime);
      const tokenData = await quickswapClient.fetchTokenData(tokenSymbolOrAddress);

      if (tokenData) {
        const responseText = `✅ **Token Data Fetched Successfully**\n\n**Token Details:**\n• **Name**: ${tokenData.name}\n• **Symbol**: ${tokenData.symbol}\n• **Address**: ${tokenData.address}\n• **Decimals**: ${tokenData.decimals}\n• **Chain ID**: ${tokenData.chainId}\n• **Source**: Quickswap`;

        return {
          text: responseText,
          actions: ['QUICKSWAP_FETCH_TOKEN_DATA'],
          data: {
            success: true,
            tokenDetails: tokenData,
            timestamp: new Date().toISOString(),
          },
        };
      } else {
        const errorMessage = `Token data for '${tokenSymbolOrAddress}' not found on Quickswap.`;
        return {
          text: `❌ **Error**: ${errorMessage}\n\nPlease verify the token symbol or address and try again.`,
          actions: ['QUICKSWAP_FETCH_TOKEN_DATA'],
          data: {
            success: false,
            error: errorMessage,
            tokenSymbolOrAddress,
            timestamp: new Date().toISOString(),
          },
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred while fetching token data';
      logger.error(`[fetchTokenDataAction] Error fetching token data:`, error);

      return {
        text: `❌ **Error**: ${errorMessage}\n\nPlease check your configuration and try again. Make sure:\n• Quickswap API URL is properly configured\n• Network connection is stable`,
        actions: ['QUICKSWAP_FETCH_TOKEN_DATA'],
        data: {
          error: errorMessage,
          tokenSymbolOrAddress,
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
          text: 'Get token data for USDC via Quickswap',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching data for USDC via Quickswap...',
          action: 'QUICKSWAP_FETCH_TOKEN_DATA',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'What are the details of WMATIC via Quickswap?',
        },
      },
      {
        name: '{{user2}} ',
        content: {
          text: 'Retrieving WMATIC token information via Quickswap...',
          action: 'QUICKSWAP_FETCH_TOKEN_DATA',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Tell me about the token at 0x2791B072600277340f1aDa76aE19A6C09bED2737 via Quickswap',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Looking up token by address via Quickswap...',
          action: 'QUICKSWAP_FETCH_TOKEN_DATA',
        },
      },
    ],
  ],
};
