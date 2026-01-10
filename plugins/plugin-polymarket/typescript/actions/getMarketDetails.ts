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
import { getMarketTemplate } from '../templates';
import type { Market } from '../types';

/**
 * Get market details by condition ID action for Polymarket
 * Fetches detailed information about a specific prediction market
 */
export const getMarketDetailsAction: Action = {
  name: 'POLYMARKET_GET_MARKET_DETAILS',
  similes: [
    'GET_MARKET',
    'MARKET_DETAILS',
    'SHOW_MARKET',
    'FETCH_MARKET',
    'MARKET_INFO',
    'GET_MARKET_INFO',
    'MARKET_BY_ID',
    'FIND_MARKET',
    'SEARCH_MARKET',
    'LOOKUP_MARKET',
  ],
  description:
    'Retrieve detailed information about a specific Polymarket prediction market by condition ID',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      logger.warn('[getMarketDetailsAction] CLOB_API_URL is required but not provided');
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
    logger.info('[getMarketDetailsAction] Handler called!');

    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      const errorMessage = 'CLOB_API_URL is required in configuration.';
      logger.error(`[getMarketDetailsAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['POLYMARKET_GET_MARKET_DETAILS'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    let conditionId = '';

    // Extract market ID using LLM
    try {
      const llmResult = await callLLMWithTimeout<{
        marketId?: string;
        query?: string;
        tokenId?: string;
        error?: string;
      }>(runtime, state, getMarketTemplate, 'getMarketDetailsAction');

      if (llmResult?.error) {
        const errorMessage = 'Market identifier not found. Please specify a market condition ID.';
        logger.error(`[getMarketDetailsAction] Parameter extraction error: ${errorMessage}`);
        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}

Please provide a market condition ID in your request. For example:
• "Show me market 0x1234567890abcdef..."
• "Get details for condition ID 0xabc123..."`,
          actions: ['POLYMARKET_GET_MARKET_DETAILS'],
          data: { error: errorMessage },
        };

        if (callback) {
          await callback(errorContent);
        }
        throw new Error(errorMessage);
      }

      conditionId = llmResult?.marketId || '';

      if (!conditionId || conditionId.trim() === '') {
        // Try to extract from query or tokenId as fallback
        const fallbackId = llmResult?.query || llmResult?.tokenId || '';
        if (fallbackId && fallbackId.match(/^0x[a-fA-F0-9]{64}$/)) {
          conditionId = fallbackId;
        } else {
          throw new Error('No valid condition ID found');
        }
      }
    } catch (error) {
      const errorMessage =
        'Unable to extract market condition ID from your message. Please provide a valid condition ID.';
      logger.error('[getMarketDetailsAction] LLM parameter extraction failed:', error);

      const errorContent: Content = {
        text: `❌ **Error**: ${errorMessage}

Please provide a market condition ID in your request. For example:
• "Show me market 0x1234567890abcdef..."
• "Get details for condition ID 0xabc123..."`,
        actions: ['POLYMARKET_GET_MARKET_DETAILS'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    try {
      // Initialize CLOB client
      const clobClient = await initializeClobClient(runtime);

      // Fetch market details
      const market: Market = await clobClient.getMarket(conditionId);

      if (!market) {
        throw new Error(`Market not found for condition ID: ${conditionId}`);
      }

      // Format response text
      let responseText = `📊 **Market Details**\n\n`;

      responseText += `**${market.question || 'Market Question Not Available'}**\n\n`;

      responseText += `**Market Information:**\n`;
      responseText += `• Condition ID: \`${market.condition_id}\`\n`;
      responseText += `• Question ID: \`${market.question_id || 'N/A'}\`\n`;
      responseText += `• Category: ${market.category || 'N/A'}\n`;
      responseText += `• Market Slug: ${market.market_slug || 'N/A'}\n`;
      responseText += `• Active: ${market.active ? '✅' : '❌'}\n`;
      responseText += `• Closed: ${market.closed ? '✅' : '❌'}\n`;

      if (market.end_date_iso) {
        responseText += `• End Date: ${new Date(market.end_date_iso).toLocaleDateString()}\n`;
      }

      if (market.game_start_time) {
        responseText += `• Game Start: ${new Date(market.game_start_time).toLocaleDateString()}\n`;
      }

      responseText += `\n**Trading Details:**\n`;
      responseText += `• Minimum Order Size: ${market.minimum_order_size || 'N/A'}\n`;
      responseText += `• Minimum Tick Size: ${market.minimum_tick_size || 'N/A'}\n`;
      responseText += `• Min Incentive Size: ${market.min_incentive_size || 'N/A'}\n`;
      responseText += `• Max Incentive Spread: ${market.max_incentive_spread || 'N/A'}\n`;

      if (market.seconds_delay) {
        responseText += `• Match Delay: ${market.seconds_delay} seconds\n`;
      }

      if (market.tokens && market.tokens.length >= 2) {
        responseText += `\n**Outcome Tokens:**\n`;
        market.tokens.forEach((token, index) => {
          responseText += `• ${token.outcome || `Token ${index + 1}`}: \`${token.token_id}\`\n`;
        });
      }

      if (market.rewards) {
        responseText += `\n**Rewards Information:**\n`;
        responseText += `• Min Size: ${market.rewards.min_size}\n`;
        responseText += `• Max Spread: ${market.rewards.max_spread}\n`;
        responseText += `• Event Start: ${market.rewards.event_start_date}\n`;
        responseText += `• Event End: ${market.rewards.event_end_date}\n`;
        responseText += `• In-Game Multiplier: ${market.rewards.in_game_multiplier}x\n`;
        responseText += `• Reward Epoch: ${market.rewards.reward_epoch}\n`;
      }

      if (market.fpmm) {
        responseText += `\n**Contract Information:**\n`;
        responseText += `• FPMM Address: \`${market.fpmm}\`\n`;
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYMARKET_GET_MARKET_DETAILS'],
        data: {
          market,
          conditionId,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      logger.error('[getMarketDetailsAction] Error fetching market details:', error);

      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Unknown error occurred while fetching market details';
      const errorContent: Content = {
        text: `❌ **Error retrieving market details**: ${errorMessage}

Please check:
• The condition ID is valid and exists
• CLOB_API_URL is correctly configured
• Network connectivity is available
• Polymarket CLOB service is operational

**Condition ID provided**: \`${conditionId}\``,
        actions: ['POLYMARKET_GET_MARKET_DETAILS'],
        data: {
          error: errorMessage,
          conditionId,
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
          text: 'Show me the details for market 0x123abc...',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll retrieve the details for that market from Polymarket.",
          action: 'POLYMARKET_GET_MARKET_DETAILS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Can I get info on condition ID 0xdef456...?',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching details for the specified market condition ID from Polymarket...',
          action: 'POLYMARKET_GET_MARKET_DETAILS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'GET_MARKET_DETAILS 0x789ghi...',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Getting market details for 0x789ghi... from Polymarket.',
          action: 'POLYMARKET_GET_MARKET_DETAILS',
        },
      },
    ],
  ],
};
