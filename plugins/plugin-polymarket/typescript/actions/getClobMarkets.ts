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
import { getClobMarketsTemplate } from '../templates';
import type { ClobClient, MarketsResponse, Market } from '@polymarket/clob-client';

interface LLMClobMarketsResult {
  limit?: number;
  next_cursor?: string;
  error?: string;
}

/**
 * Get CLOB Markets Action for Polymarket.
 * Retrieves a paginated list of markets directly from the Polymarket CLOB API.
 */
export const getClobMarketsAction: Action = {
  name: 'POLYMARKET_GET_CLOB_MARKETS',
  similes: ['FETCH_CLOB_MARKETS', 'LIST_CLOB_MARKETS', 'CLOB_MARKET_DATA'].map(
    (s) => `POLYMARKET_${s}`
  ),
  description:
    'Retrieves a paginated list of markets directly from the Polymarket CLOB API, including pagination support.',

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    logger.info(`[getClobMarketsAction] Validate called for message: "${message.content?.text}"`);
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      logger.warn('[getClobMarketsAction] CLOB_API_URL is required.');
      return false;
    }
    logger.info('[getClobMarketsAction] Validation passed');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getClobMarketsAction] Handler called!');

    let llmResult: LLMClobMarketsResult = {};
    try {
      const result = await callLLMWithTimeout<LLMClobMarketsResult>(
        runtime,
        state,
        getClobMarketsTemplate,
        'getClobMarketsAction'
      );
      if (result && !isLLMError(result)) {
        llmResult = result;
      }
      logger.info(`[getClobMarketsAction] LLM result: ${JSON.stringify(llmResult)}`);
    } catch (error) {
      logger.warn('[getClobMarketsAction] LLM extraction failed, using defaults', error);
    }

    const limit = llmResult.limit || 10;
    const nextCursor = llmResult.next_cursor;

    logger.info(`[getClobMarketsAction] Fetching CLOB markets with limit=${limit}, cursor=${nextCursor || 'none'}`);

    try {
      const client = await initializeClobClient(runtime) as ClobClient;
      const marketsResponse: MarketsResponse = await client.getMarkets(nextCursor);
      const markets: Market[] = marketsResponse.data || [];

      let responseText = `📊 **Polymarket CLOB Markets**:\n\n`;

      if (markets && markets.length > 0) {
        responseText += `Found ${markets.length} market(s):\n\n`;
        const displayMarkets = markets.slice(0, limit);
        displayMarkets.forEach((market: Market, index: number) => {
          responseText += `**${index + 1}. ${market.question || market.condition_id}**\n`;
          responseText += `   • **Condition ID**: \`${market.condition_id}\`\n`;
          if (market.tokens && market.tokens.length > 0) {
            responseText += `   • **Tokens**: ${market.tokens.map((t) => t.token_id?.substring(0, 8) + '...' || 'N/A').join(', ')}\n`;
          }
          responseText += `   • **Active**: ${market.active ? '✅ Yes' : '❌ No'}\n`;
          if (market.end_date_iso) {
            responseText += `   • **End Date**: ${new Date(market.end_date_iso).toLocaleString()}\n`;
          }
          responseText += `\n`;
        });

        if (marketsResponse.next_cursor) {
          responseText += `\n📄 *More results available. Use next_cursor: \`${marketsResponse.next_cursor}\` to fetch more.*\n`;
        }
      } else {
        responseText += `No markets found.\n`;
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYMARKET_GET_CLOB_MARKETS'],
        data: {
          markets,
          next_cursor: marketsResponse.next_cursor,
          limit,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[getClobMarketsAction] Error fetching CLOB markets:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error fetching CLOB markets**: ${errorMessage}`,
        actions: ['POLYMARKET_GET_CLOB_MARKETS'],
        data: {
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
      { name: '{{user1}}', content: { text: 'Show me markets from the Polymarket CLOB.' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching markets from the Polymarket CLOB API...',
          action: 'POLYMARKET_GET_CLOB_MARKETS',
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'Get the next page of CLOB markets via Polymarket.' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching the next page of CLOB markets from Polymarket...',
          action: 'POLYMARKET_GET_CLOB_MARKETS',
        },
      },
    ],
  ],
};
