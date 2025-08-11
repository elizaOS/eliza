import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
  ModelType,
  composePromptFromState,
} from '@elizaos/core';
import { callLLMWithTimeout } from '../utils/llmHelpers';
import { initializeClobClient } from '../utils/clobClient';
import { getSpreadTemplate } from '../templates';

interface SpreadParams {
  tokenId: string;
}

/**
 * Get spread for a market token action for Polymarket
 * Fetches the spread (difference between best ask and best bid) for a specific token
 */
export const getSpreadAction: Action = {
  name: 'POLYMARKET_GET_SPREAD',
  similes: [
    'SPREAD',
    'GET_SPREAD',
    'SHOW_SPREAD',
    'FETCH_SPREAD',
    'SPREAD_DATA',
    'MARKET_SPREAD',
    'BID_ASK_SPREAD',
    'GET_BID_ASK_SPREAD',
    'SHOW_BID_ASK_SPREAD',
    'FETCH_BID_ASK_SPREAD',
    'SPREAD_CHECK',
    'CHECK_SPREAD',
    'SPREAD_LOOKUP',
    'TOKEN_SPREAD',
    'MARKET_BID_ASK',
    'GET_MARKET_SPREAD',
    'SHOW_MARKET_SPREAD',
    'FETCH_MARKET_SPREAD',
  ],
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info('[getSpreadAction] Validating action trigger');
    return true;
  },
  description:
    'Get the spread (difference between best ask and best bid) for a specific Polymarket token using the CLOB API spread endpoint.',
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    try {
      logger.info('[getSpreadAction] Starting spread retrieval process');

      // Initialize CLOB client
      const clobClient = await initializeClobClient(runtime);

      let tokenId: string;

      try {
        // Use LLM to extract parameters
        const llmResult = await callLLMWithTimeout<{ tokenId?: string; error?: string }>(
          runtime,
          state,
          getSpreadTemplate,
          'getSpreadAction'
        );

        logger.info('[getSpreadAction] LLM result:', JSON.stringify(llmResult));

        if (llmResult?.error) {
          throw new Error('Token ID not found');
        }

        tokenId = llmResult?.tokenId || '';

        if (!tokenId) {
          throw new Error('Token ID not found');
        }
      } catch (error) {
        logger.warn('[getSpreadAction] LLM extraction failed, trying regex fallback');

        // Fallback to regex extraction
        const text = message.content?.text || '';

        // Extract token ID - prioritize standalone numbers
        const numberMatch = text.match(/\b(\d{5,})\b/);
        if (numberMatch) {
          tokenId = numberMatch[1];
        } else {
          // Fallback to keyword-based extraction
          const keywordMatch = text.match(/(?:token|market|id|spread)\s+([a-zA-Z0-9]+)/i);
          tokenId = keywordMatch?.[1] || '';
        }

        if (!tokenId) {
          const errorMessage = 'Please provide a token ID to get the spread for.';
          logger.error(`[getSpreadAction] Token ID extraction failed`);

          const errorContent: Content = {
            text: `❌ **Error**: ${errorMessage}

Please provide a token ID in your request. Examples:
• "Get spread for token 123456"
• "What's the spread for market token 789012?"
• "Show me the bid-ask spread for 456789"`,
            actions: ['POLYMARKET_GET_SPREAD'],
            data: { error: errorMessage },
          };

          if (callback) {
            await callback(errorContent);
          }
          throw new Error(errorMessage);
        }
      }

      logger.info(`[getSpreadAction] Fetching spread for token: ${tokenId}`);

      // Fetch spread from CLOB API
      const spreadResponse = await clobClient.getSpread(tokenId);
      logger.info(`[getSpreadAction] Successfully retrieved spread: ${spreadResponse.spread}`);

      // Convert spread to number and format it
      const spreadValue = parseFloat(spreadResponse.spread);
      const formattedSpread = spreadValue.toFixed(4);
      const percentageSpread = (spreadValue * 100).toFixed(2);

      const successMessage = `✅ **Spread for Token ${tokenId}**

📊 **Spread**: \`${formattedSpread}\` (${percentageSpread}%)

**Details**:
• **Token ID**: \`${tokenId}\`
• **Spread Value**: \`${formattedSpread}\`
• **Percentage**: \`${percentageSpread}%\`

*The spread represents the difference between the best ask and best bid prices.*`;

      const responseContent: Content = {
        text: successMessage,
        actions: ['POLYMARKET_GET_SPREAD'],
        data: {
          tokenId,
          spread: spreadResponse.spread,
          formattedSpread,
          percentageSpread,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      logger.error('[getSpreadAction] Error getting spread:', error);

      const errorMessage = `❌ **Error getting spread**: ${error instanceof Error ? error.message : String(error)}

Please check:
• The token ID is valid and exists
• CLOB_API_URL is correctly configured
• Network connectivity is available`;

      const errorContent: Content = {
        text: errorMessage,
        actions: ['POLYMARKET_GET_SPREAD'],
        data: {
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw error;
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Get spread for token 71321045679252212594626385532706912750332728571942532289631379312455583992563 via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll fetch the spread for that token via Polymarket.",
          actions: ['POLYMARKET_GET_SPREAD'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: "What's the bid-ask spread for market token 123456 via Polymarket?",
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me get the spread for that market token via Polymarket.',
          actions: ['POLYMARKET_GET_SPREAD'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Show me the spread for 789012 via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Getting the spread for token 789012 via Polymarket.',
          actions: ['POLYMARKET_GET_SPREAD'],
        },
      },
    ],
  ],
};
