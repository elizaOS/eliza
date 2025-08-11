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
import { getSimplifiedMarketsTemplate } from '../templates';
import type { SimplifiedMarket } from '../types';

/**
 * Get simplified market data action for Polymarket
 * Fetches markets in a simplified schema with reduced fields
 */
export const getSimplifiedMarketsAction: Action = {
  name: 'POLYMARKET_GET_SIMPLIFIED_MARKETS',
  similes: [
    'LIST_SIMPLIFIED_MARKETS',
    'SHOW_SIMPLIFIED_MARKETS',
    'GET_SIMPLE_MARKETS',
    'FETCH_SIMPLIFIED_MARKETS',
    'SIMPLIFIED_MARKETS',
    'SIMPLE_MARKETS',
    'SHOW_SIMPLIFIED_DATA',
    'GET_SIMPLIFIED_DATA',
    'SIMPLIFIED_MARKET_DATA',
    'SIMPLE_MARKET_DATA',
    'SHOW_SIMPLE_MARKETS',
    'LIST_SIMPLE_MARKETS',
  ],
  description: 'Retrieve simplified prediction market data from Polymarket with reduced schema',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      logger.warn('[getSimplifiedMarketsAction] CLOB_API_URL is required but not provided');
      return false;
    }

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getSimplifiedMarketsAction] Handler called!');

    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      const errorMessage = 'CLOB_API_URL is required in configuration.';
      logger.error(`[getSimplifiedMarketsAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['POLYMARKET_GET_SIMPLIFIED_MARKETS'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    let nextCursor = '';

    // Extract optional pagination cursor using LLM
    try {
      const llmResult = await callLLMWithTimeout<{ next_cursor?: string; error?: string }>(
        runtime,
        state,
        getSimplifiedMarketsTemplate,
        'getSimplifiedMarketsAction'
      );

      if (llmResult?.error) {
        logger.info(
          '[getSimplifiedMarketsAction] No pagination cursor requested, fetching first page'
        );
        nextCursor = '';
      } else {
        nextCursor = llmResult?.next_cursor || '';
      }
    } catch (error) {
      logger.debug(
        '[getSimplifiedMarketsAction] LLM parameter extraction failed, using defaults:',
        error
      );
      nextCursor = '';
    }

    try {
      // Initialize CLOB client
      const clobClient = await initializeClobClient(runtime);

      // Fetch simplified markets with optional pagination
      const response = await clobClient.getSimplifiedMarkets(nextCursor);

      if (!response || !response.data) {
        throw new Error('Invalid response from CLOB API');
      }

      const markets: SimplifiedMarket[] = response.data;
      const marketCount = markets.length;

      // Filter out markets with missing essential data
      const validMarkets = markets.filter(
        (market) =>
          market.condition_id &&
          market.tokens &&
          market.tokens.length === 2 &&
          market.tokens[0]?.token_id &&
          market.tokens[1]?.token_id
      );

      // Format response text
      let responseText = `📊 **Retrieved ${marketCount} Simplified Polymarket markets**\n`;

      if (validMarkets.length < marketCount) {
        responseText += `📝 **Note**: ${marketCount - validMarkets.length} markets filtered out due to incomplete data\n`;
      }

      responseText += `\n`;

      if (validMarkets.length === 0) {
        responseText += 'No valid simplified markets found.';
      } else {
        // Show first few valid markets as preview
        const previewMarkets = validMarkets.slice(0, 5);
        responseText += '**Sample Simplified Markets:**\n';

        previewMarkets.forEach((market: SimplifiedMarket, index: number) => {
          const yesToken =
            market.tokens.find((token) => token.outcome === 'Yes') || market.tokens[0];
          const noToken = market.tokens.find((token) => token.outcome === 'No') || market.tokens[1];

          responseText += `${index + 1}. **Condition ID**: ${market.condition_id}\n`;
          responseText += `   • Tokens: ${yesToken.outcome || 'Token1'} (${yesToken.token_id.slice(0, 8)}...) / ${noToken.outcome || 'Token2'} (${noToken.token_id.slice(0, 8)}...)\n`;
          responseText += `   • Active: ${market.active ? '✅' : '❌'}\n`;
          responseText += `   • Closed: ${market.closed ? '✅' : '❌'}\n`;
          responseText += `   • Min Incentive Size: ${market.min_incentive_size || 'Not specified'}\n\n`;
        });

        if (validMarkets.length > 5) {
          responseText += `... and ${validMarkets.length - 5} more simplified markets\n\n`;
        }

        responseText += `**Summary:**\n`;
        responseText += `• Total Simplified Markets: ${validMarkets.length} (${marketCount} total retrieved)\n`;
        responseText += `• Simplified schema includes: condition_id, tokens, rewards, incentives, status\n`;
        responseText += `• Reduced data for faster processing and lower bandwidth\n`;

        if (response.next_cursor && response.next_cursor !== 'LTE=') {
          responseText += `• More results available (paginated)\n`;
        }
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYMARKET_GET_SIMPLIFIED_MARKETS'],
        data: {
          markets: validMarkets, // Return only valid markets
          count: validMarkets.length,
          total: response.count || marketCount,
          filtered: marketCount - validMarkets.length,
          next_cursor: response.next_cursor,
          limit: response.limit,
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      logger.error('[getSimplifiedMarketsAction] Error fetching simplified markets:', error);

      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Unknown error occurred while fetching simplified markets';
      const errorContent: Content = {
        text: `❌ **Error retrieving simplified markets**: ${errorMessage}

Please check:
• CLOB_API_URL is correctly configured
• Network connectivity is available
• Polymarket CLOB service is operational`,
        actions: ['POLYMARKET_GET_SIMPLIFIED_MARKETS'],
        data: {
          error: errorMessage,
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
          text: 'Show me simplified market data via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll retrieve simplified Polymarket data for faster processing.",
          action: 'POLYMARKET_GET_SIMPLIFIED_MARKETS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Get markets in simplified format via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me fetch the markets using the simplified schema.',
          action: 'POLYMARKET_GET_SIMPLIFIED_MARKETS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'I need simple market data for analysis via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Retrieving simplified market data for your analysis.',
          action: 'POLYMARKET_GET_SIMPLIFIED_MARKETS',
        },
      },
    ],
  ],
};
