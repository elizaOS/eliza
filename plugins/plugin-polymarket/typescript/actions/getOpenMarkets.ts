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
import { getOpenMarketsTemplate } from '../templates';
import type { ClobClient, MarketsResponse, Market } from '@polymarket/clob-client';

interface LLMOpenMarketsResult {
  limit?: number;
  next_cursor?: string;
  error?: string;
}

/**
 * Get Open Markets Action for Polymarket.
 * Retrieves a list of currently open (active and not closed) markets.
 */
export const getOpenMarketsAction: Action = {
  name: 'POLYMARKET_GET_OPEN_MARKETS',
  similes: ['LIST_ACTIVE_MARKETS', 'SHOW_OPEN_MARKETS', 'TRADABLE_MARKETS', 'CURRENT_MARKETS'].map(
    (s) => `POLYMARKET_${s}`
  ),
  description:
    'Retrieves a list of currently open (active and not closed) markets from Polymarket.',

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    logger.info(`[getOpenMarketsAction] Validate called for message: "${message.content?.text}"`);
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      logger.warn('[getOpenMarketsAction] CLOB_API_URL is required.');
      return false;
    }
    logger.info('[getOpenMarketsAction] Validation passed');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getOpenMarketsAction] Handler called!');

    let llmResult: LLMOpenMarketsResult = {};
    try {
      const result = await callLLMWithTimeout<LLMOpenMarketsResult>(
        runtime,
        state,
        getOpenMarketsTemplate,
        'getOpenMarketsAction'
      );
      if (result && !isLLMError(result)) {
        llmResult = result;
      }
      logger.info(`[getOpenMarketsAction] LLM result: ${JSON.stringify(llmResult)}`);
    } catch (error) {
      logger.warn('[getOpenMarketsAction] LLM extraction failed, using defaults', error);
    }

    const limit = llmResult.limit || 10;
    const nextCursor = llmResult.next_cursor;

    logger.info(`[getOpenMarketsAction] Fetching open markets with limit=${limit}`);

    try {
      const client = await initializeClobClient(runtime) as ClobClient;
      const marketsResponse: MarketsResponse = await client.getMarkets(nextCursor);
      const allMarkets: Market[] = marketsResponse.data || [];

      // Filter for open markets (active = true, closed = false)
      const openMarkets = allMarkets.filter(
        (market: Market) => market.active === true && market.closed === false
      );

      let responseText = `📊 **Open Polymarket Markets**:\n\n`;

      if (openMarkets && openMarkets.length > 0) {
        responseText += `Found ${openMarkets.length} open market(s):\n\n`;
        const displayMarkets = openMarkets.slice(0, limit);
        displayMarkets.forEach((market: Market, index: number) => {
          responseText += `**${index + 1}. ${market.question || market.condition_id}**\n`;
          responseText += `   • **Condition ID**: \`${market.condition_id}\`\n`;
          if (market.end_date_iso) {
            responseText += `   • **End Date**: ${new Date(market.end_date_iso).toLocaleString()}\n`;
          }
          if (market.tokens && market.tokens.length > 0) {
            responseText += `   • **Tokens**: ${market.tokens.length} outcome(s)\n`;
          }
          responseText += `\n`;
        });

        if (openMarkets.length > limit) {
          responseText += `\n📄 *Showing ${limit} of ${openMarkets.length} open markets.*\n`;
        }
        if (marketsResponse.next_cursor) {
          responseText += `*More results available. Use next_cursor: \`${marketsResponse.next_cursor}\` to fetch more.*\n`;
        }
      } else {
        responseText += `No open markets found at this time.\n`;
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYMARKET_GET_OPEN_MARKETS'],
        data: {
          markets: openMarkets.slice(0, limit),
          totalOpenMarkets: openMarkets.length,
          next_cursor: marketsResponse.next_cursor,
          limit,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[getOpenMarketsAction] Error fetching open markets:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error fetching open markets**: ${errorMessage}`,
        actions: ['POLYMARKET_GET_OPEN_MARKETS'],
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
      { name: '{{user1}}', content: { text: 'Show me the currently open markets on Polymarket.' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching currently open markets from Polymarket...',
          action: 'POLYMARKET_GET_OPEN_MARKETS',
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'What markets are tradable right now on Polymarket?' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Looking up tradable markets on Polymarket...',
          action: 'POLYMARKET_GET_OPEN_MARKETS',
        },
      },
    ],
  ],
};
