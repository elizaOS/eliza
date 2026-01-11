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
import { getSimplifiedMarketsTemplate } from '../templates';
import type { ClobClient, MarketsResponse, Market } from '@polymarket/clob-client';

interface LLMSimplifiedMarketsResult {
  limit?: number;
  next_cursor?: string;
  error?: string;
}

interface SimplifiedMarket {
  condition_id: string;
  question: string;
  active: boolean;
  closed: boolean;
  end_date?: string;
  outcomes: number;
}

/**
 * Get Simplified Markets Action for Polymarket.
 * Retrieves a simplified view of markets with essential information only.
 */
export const getSimplifiedMarketsAction: Action = {
  name: 'POLYMARKET_GET_SIMPLIFIED_MARKETS',
  similes: ['SIMPLE_MARKETS', 'MARKET_LIST', 'BASIC_MARKETS', 'QUICK_MARKETS'].map(
    (s) => `POLYMARKET_${s}`
  ),
  description:
    'Retrieves a simplified list of markets from Polymarket with essential information only.',

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    logger.info(
      `[getSimplifiedMarketsAction] Validate called for message: "${message.content?.text}"`
    );
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      logger.warn('[getSimplifiedMarketsAction] CLOB_API_URL is required.');
      return false;
    }
    logger.info('[getSimplifiedMarketsAction] Validation passed');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getSimplifiedMarketsAction] Handler called!');

    let llmResult: LLMSimplifiedMarketsResult = {};
    try {
      const result = await callLLMWithTimeout<LLMSimplifiedMarketsResult>(
        runtime,
        state,
        getSimplifiedMarketsTemplate,
        'getSimplifiedMarketsAction'
      );
      if (result && !isLLMError(result)) {
        llmResult = result;
      }
      logger.info(`[getSimplifiedMarketsAction] LLM result: ${JSON.stringify(llmResult)}`);
    } catch (error) {
      logger.warn('[getSimplifiedMarketsAction] LLM extraction failed, using defaults', error);
    }

    const limit = llmResult.limit || 10;
    const nextCursor = llmResult.next_cursor;

    logger.info(`[getSimplifiedMarketsAction] Fetching simplified markets with limit=${limit}`);

    try {
      const client = await initializeClobClient(runtime) as ClobClient;
      const marketsResponse: MarketsResponse = await client.getMarkets(nextCursor);
      const allMarkets: Market[] = marketsResponse.data || [];

      // Create simplified view
      const simplifiedMarkets: SimplifiedMarket[] = allMarkets.slice(0, limit).map((market: Market) => ({
        condition_id: market.condition_id,
        question: market.question || 'N/A',
        active: market.active ?? false,
        closed: market.closed ?? false,
        end_date: market.end_date_iso,
        outcomes: market.tokens?.length || 0,
      }));

      let responseText = `📋 **Simplified Polymarket Markets**:\n\n`;

      if (simplifiedMarkets && simplifiedMarkets.length > 0) {
        responseText += `Showing ${simplifiedMarkets.length} market(s):\n\n`;
        simplifiedMarkets.forEach((market: SimplifiedMarket, index: number) => {
          const statusEmoji = market.active && !market.closed ? '🟢' : '🔴';
          responseText += `**${index + 1}.** ${statusEmoji} ${market.question}\n`;
          responseText += `   ID: \`${market.condition_id.substring(0, 12)}...\` | Outcomes: ${market.outcomes}`;
          if (market.end_date) {
            responseText += ` | Ends: ${new Date(market.end_date).toLocaleDateString()}`;
          }
          responseText += `\n\n`;
        });

        if (marketsResponse.next_cursor) {
          responseText += `\n📄 *More markets available. Use cursor: \`${marketsResponse.next_cursor}\`*\n`;
        }
      } else {
        responseText += `No markets found.\n`;
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYMARKET_GET_SIMPLIFIED_MARKETS'],
        data: {
          markets: simplifiedMarkets,
          limit,
          next_cursor: marketsResponse.next_cursor,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[getSimplifiedMarketsAction] Error fetching simplified markets:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error fetching simplified markets**: ${errorMessage}`,
        actions: ['POLYMARKET_GET_SIMPLIFIED_MARKETS'],
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
      { name: '{{user1}}', content: { text: 'Give me a simple list of Polymarket markets.' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching a simplified list of Polymarket markets...',
          action: 'POLYMARKET_GET_SIMPLIFIED_MARKETS',
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'Show me a quick overview of markets on Polymarket.' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Getting a quick market overview from Polymarket...',
          action: 'POLYMARKET_GET_SIMPLIFIED_MARKETS',
        },
      },
    ],
  ],
};
