import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from '@elizaos/core';
import { callLLMWithTimeout, isLLMError } from '../utils/llmHelpers';
import { initializeClobClient } from '../utils/clobClient';
import { getMarketDetailsTemplate } from '../templates';
import type { ClobClient, Market } from '@polymarket/clob-client';

interface LLMMarketDetailsResult {
  conditionId?: string;
  error?: string;
}

/**
 * Get Market Details Action for Polymarket.
 * Retrieves detailed information about a specific market by its condition ID.
 */
export const getMarketDetailsAction: Action = {
  name: 'POLYMARKET_GET_MARKET_DETAILS',
  similes: ['MARKET_INFO', 'MARKET_DATA', 'SHOW_MARKET', 'VIEW_MARKET'].map(
    (s) => `POLYMARKET_${s}`
  ),
  description:
    'Retrieves detailed information about a specific Polymarket market by its condition ID.',

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    logger.info(`[getMarketDetailsAction] Validate called for message: "${message.content?.text}"`);
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      logger.warn('[getMarketDetailsAction] CLOB_API_URL is required.');
      return false;
    }
    logger.info('[getMarketDetailsAction] Validation passed');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getMarketDetailsAction] Handler called!');

    let llmResult: LLMMarketDetailsResult = {};
    try {
      const result = await callLLMWithTimeout<LLMMarketDetailsResult>(
        runtime,
        state,
        getMarketDetailsTemplate,
        'getMarketDetailsAction'
      );
      if (result && !isLLMError(result)) {
        llmResult = result;
      }
      logger.info(`[getMarketDetailsAction] LLM result: ${JSON.stringify(llmResult)}`);

      if (llmResult.error || !llmResult.conditionId) {
        throw new Error(llmResult.error || 'Condition ID not found in LLM result.');
      }
    } catch (error) {
      logger.warn('[getMarketDetailsAction] LLM extraction failed, trying regex fallback', error);
      const text = message.content?.text || '';

      const conditionIdMatch = text.match(
        /(?:condition[_\s]?id|market|id)[:\s=#]?\s*([0-9a-zA-Z_\-]+)/i
      );

      if (conditionIdMatch) {
        llmResult.conditionId = conditionIdMatch[1];
        logger.info(
          `[getMarketDetailsAction] Regex extracted conditionId: ${llmResult.conditionId}`
        );
      } else {
        const errorMessage = 'Please specify a Condition ID to get market details.';
        logger.error(`[getMarketDetailsAction] Extraction failed. Text: "${text}"`);
        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}`,
          actions: ['GET_MARKET_DETAILS'],
          data: { error: errorMessage },
        };
        if (callback) await callback(errorContent);
        throw new Error(errorMessage);
      }
    }

    const conditionId = llmResult.conditionId!;

    logger.info(`[getMarketDetailsAction] Fetching details for condition ID: ${conditionId}`);

    try {
      const client = await initializeClobClient(runtime) as ClobClient;
      const market: Market = await client.getMarket(conditionId);

      let responseText = `📊 **Market Details for ${conditionId}**:\n\n`;

      if (market) {
        responseText += `• **Question**: ${market.question || 'N/A'}\n`;
        responseText += `• **Description**: ${market.description || 'N/A'}\n`;
        responseText += `• **Condition ID**: \`${market.condition_id}\`\n`;
        responseText += `• **Active**: ${market.active ? '✅ Yes' : '❌ No'}\n`;
        responseText += `• **Closed**: ${market.closed ? '✅ Yes' : '❌ No'}\n`;
        if (market.end_date_iso) {
          responseText += `• **End Date**: ${new Date(market.end_date_iso).toLocaleString()}\n`;
        }
        if (market.tokens && market.tokens.length > 0) {
          responseText += `• **Tokens**:\n`;
          market.tokens.forEach((token) => {
            responseText += `   - Token ID: \`${token.token_id}\` (Outcome: ${token.outcome || 'N/A'})\n`;
          });
        }
        if (market.market_slug) {
          responseText += `• **Slug**: ${market.market_slug}\n`;
        }
        if (market.minimum_order_size) {
          responseText += `• **Minimum Order Size**: ${market.minimum_order_size}\n`;
        }
        if (market.minimum_tick_size) {
          responseText += `• **Minimum Tick Size**: ${market.minimum_tick_size}\n`;
        }
      } else {
        responseText += `No market found for the provided condition ID.\n`;
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['GET_MARKET_DETAILS'],
        data: {
          market,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error(`[getMarketDetailsAction] Error fetching market ${conditionId}:`, error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error fetching market details**: ${errorMessage}`,
        actions: ['GET_MARKET_DETAILS'],
        data: {
          conditionId,
          error: errorMessage,
          timestamp: new Date().toISOString(),
        },
      };
      if (callback) await callback(errorContent);
      throw error;
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Get details for market condition_id abc123 on Polymarket.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching details for market abc123 on Polymarket...',
          action: 'POLYMARKET_GET_MARKET_DETAILS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Show me info about the Polymarket market 0xdef456.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Looking up market information for 0xdef456 on Polymarket...',
          action: 'POLYMARKET_GET_MARKET_DETAILS',
        },
      },
    ],
  ],
};
