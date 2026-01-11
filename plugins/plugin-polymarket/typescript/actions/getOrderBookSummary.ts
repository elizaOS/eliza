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
import { getOrderBookSummaryTemplate } from '../templates';
import type { ClobClient, OrderBookSummary } from '@polymarket/clob-client';

interface LLMOrderBookSummaryResult {
  tokenId?: string;
  error?: string;
}

/**
 * Get Order Book Summary Action for Polymarket.
 * Retrieves a summary of the order book for a specific token.
 */
export const getOrderBookSummaryAction: Action = {
  name: 'POLYMARKET_GET_ORDER_BOOK_SUMMARY',
  similes: ['ORDER_BOOK_OVERVIEW', 'BOOK_SUMMARY', 'MARKET_DEPTH_SUMMARY'].map(
    (s) => `POLYMARKET_${s}`
  ),
  description:
    'Retrieves a summary of the order book for a specific token ID on Polymarket, including best bid/ask and spread.',

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    logger.info(
      `[getOrderBookSummaryAction] Validate called for message: "${message.content?.text}"`
    );
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      logger.warn('[getOrderBookSummaryAction] CLOB_API_URL is required.');
      return false;
    }
    logger.info('[getOrderBookSummaryAction] Validation passed');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getOrderBookSummaryAction] Handler called!');

    let llmResult: LLMOrderBookSummaryResult = {};
    try {
      const result = await callLLMWithTimeout<LLMOrderBookSummaryResult>(
        runtime,
        state,
        getOrderBookSummaryTemplate,
        'getOrderBookSummaryAction'
      );
      if (result && !isLLMError(result)) {
        llmResult = result;
      }
      logger.info(`[getOrderBookSummaryAction] LLM result: ${JSON.stringify(llmResult)}`);

      if (llmResult.error || !llmResult.tokenId) {
        throw new Error(llmResult.error || 'Token ID not found in LLM result.');
      }
    } catch (error) {
      logger.warn('[getOrderBookSummaryAction] LLM extraction failed, trying regex fallback', error);
      const text = message.content?.text || '';

      const tokenIdMatch = text.match(
        /(?:token|tokenId|asset|id|summary\s+for)\s*[:=#]?\s*([0-9a-zA-Z_\-]+)/i
      );

      if (tokenIdMatch) {
        llmResult.tokenId = tokenIdMatch[1];
        logger.info(
          `[getOrderBookSummaryAction] Regex extracted tokenId: ${llmResult.tokenId}`
        );
      } else {
        const errorMessage = 'Please specify a Token ID to get order book summary.';
        logger.error(`[getOrderBookSummaryAction] Extraction failed. Text: "${text}"`);
        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}`,
          actions: ['GET_ORDER_BOOK_SUMMARY'],
          data: { error: errorMessage },
        };
        if (callback) await callback(errorContent);
        throw new Error(errorMessage);
      }
    }

    const tokenId = llmResult.tokenId!;

    logger.info(`[getOrderBookSummaryAction] Fetching order book summary for token: ${tokenId}`);

    try {
      const client = await initializeClobClient(runtime) as ClobClient;
      const summary: OrderBookSummary = await client.getOrderBookSummary(tokenId);

      let responseText = `📊 **Order Book Summary for Token ${tokenId}**:\n\n`;

      if (summary) {
        responseText += `• **Spread**: ${summary.spread || 'N/A'}\n`;
        responseText += `• **Best Bid**: $${summary.bid || 'N/A'}\n`;
        responseText += `• **Best Ask**: $${summary.ask || 'N/A'}\n`;

        if (summary.bid && summary.ask) {
          const midpoint =
            (parseFloat(summary.bid) + parseFloat(summary.ask)) / 2;
          responseText += `• **Midpoint**: $${midpoint.toFixed(4)}\n`;
        }
      } else {
        responseText += `Could not retrieve order book summary. The order book may be empty.\n`;
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['GET_ORDER_BOOK_SUMMARY'],
        data: {
          tokenId,
          summary,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error(
        `[getOrderBookSummaryAction] Error getting order book summary for ${tokenId}:`,
        error
      );
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error getting order book summary**: ${errorMessage}`,
        actions: ['GET_ORDER_BOOK_SUMMARY'],
        data: {
          tokenId,
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
        content: { text: 'Give me the order book summary for token xyz123 on Polymarket.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching order book summary for token xyz123 on Polymarket...',
          action: 'POLYMARKET_GET_ORDER_BOOK_SUMMARY',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'What is the spread for token 0xabc789 via Polymarket?' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Looking up the order book summary for token 0xabc789 on Polymarket...',
          action: 'POLYMARKET_GET_ORDER_BOOK_SUMMARY',
        },
      },
    ],
  ],
};
