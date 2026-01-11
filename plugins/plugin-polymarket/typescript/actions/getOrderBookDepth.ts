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
import { getOrderBookDepthTemplate } from '../templates';
import type { ClobClient, OrderBookDepth } from '@polymarket/clob-client';

interface LLMOrderBookDepthResult {
  tokenId?: string;
  error?: string;
}

/**
 * Get Order Book Depth Action for Polymarket.
 * Retrieves the order book depth (all bids and asks) for a specific token.
 */
export const getOrderBookDepthAction: Action = {
  name: 'POLYMARKET_GET_ORDER_BOOK_DEPTH',
  similes: ['FULL_ORDER_BOOK', 'ORDER_DEPTH', 'ALL_ORDERS', 'DEPTH_OF_MARKET'].map(
    (s) => `POLYMARKET_${s}`
  ),
  description:
    'Retrieves the full order book depth (all bids and asks) for a specific token ID on Polymarket.',

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    logger.info(
      `[getOrderBookDepthAction] Validate called for message: "${message.content?.text}"`
    );
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      logger.warn('[getOrderBookDepthAction] CLOB_API_URL is required.');
      return false;
    }
    logger.info('[getOrderBookDepthAction] Validation passed');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getOrderBookDepthAction] Handler called!');

    let llmResult: LLMOrderBookDepthResult = {};
    try {
      const result = await callLLMWithTimeout<LLMOrderBookDepthResult>(
        runtime,
        state,
        getOrderBookDepthTemplate,
        'getOrderBookDepthAction'
      );
      if (result && !isLLMError(result)) {
        llmResult = result;
      }
      logger.info(`[getOrderBookDepthAction] LLM result: ${JSON.stringify(llmResult)}`);

      if (llmResult.error || !llmResult.tokenId) {
        throw new Error(llmResult.error || 'Token ID not found in LLM result.');
      }
    } catch (error) {
      logger.warn('[getOrderBookDepthAction] LLM extraction failed, trying regex fallback', error);
      const text = message.content?.text || '';

      const tokenIdMatch = text.match(
        /(?:token|tokenId|asset|id|depth\s+for)\s*[:=#]?\s*([0-9a-zA-Z_\-]+)/i
      );

      if (tokenIdMatch) {
        llmResult.tokenId = tokenIdMatch[1];
        logger.info(
          `[getOrderBookDepthAction] Regex extracted tokenId: ${llmResult.tokenId}`
        );
      } else {
        const errorMessage = 'Please specify a Token ID to get order book depth.';
        logger.error(`[getOrderBookDepthAction] Extraction failed. Text: "${text}"`);
        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}`,
          actions: ['GET_ORDER_BOOK_DEPTH'],
          data: { error: errorMessage },
        };
        if (callback) await callback(errorContent);
        throw new Error(errorMessage);
      }
    }

    const tokenId = llmResult.tokenId!;

    logger.info(`[getOrderBookDepthAction] Fetching order book depth for token: ${tokenId}`);

    try {
      const client = await initializeClobClient(runtime) as ClobClient;
      const depth: OrderBookDepth = await client.getOrderBook(tokenId);

      let responseText = `📊 **Order Book Depth for Token ${tokenId}**:\n\n`;

      const bids = depth?.bids || [];
      const asks = depth?.asks || [];

      responseText += `**Bids (Buy Orders):** ${bids.length}\n`;
      if (bids.length > 0) {
        const topBids = bids.slice(0, 5);
        topBids.forEach(
          (bid: { price: string; size: string }, index: number) => {
            responseText += `  ${index + 1}. $${parseFloat(bid.price).toFixed(4)} × ${bid.size}\n`;
          }
        );
        if (bids.length > 5) {
          responseText += `  ... and ${bids.length - 5} more bids\n`;
        }
      } else {
        responseText += `  No bids currently.\n`;
      }

      responseText += `\n**Asks (Sell Orders):** ${asks.length}\n`;
      if (asks.length > 0) {
        const topAsks = asks.slice(0, 5);
        topAsks.forEach(
          (ask: { price: string; size: string }, index: number) => {
            responseText += `  ${index + 1}. $${parseFloat(ask.price).toFixed(4)} × ${ask.size}\n`;
          }
        );
        if (asks.length > 5) {
          responseText += `  ... and ${asks.length - 5} more asks\n`;
        }
      } else {
        responseText += `  No asks currently.\n`;
      }

      // Calculate spread if we have both bids and asks
      if (bids.length > 0 && asks.length > 0) {
        const bestBid = parseFloat(bids[0].price);
        const bestAsk = parseFloat(asks[0].price);
        const spread = bestAsk - bestBid;
        const spreadPercent = ((spread / bestAsk) * 100).toFixed(2);
        responseText += `\n**Spread:** $${spread.toFixed(4)} (${spreadPercent}%)\n`;
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['GET_ORDER_BOOK_DEPTH'],
        data: {
          tokenId,
          bids: bids.slice(0, 10),
          asks: asks.slice(0, 10),
          totalBids: bids.length,
          totalAsks: asks.length,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error(
        `[getOrderBookDepthAction] Error getting order book depth for ${tokenId}:`,
        error
      );
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error getting order book depth**: ${errorMessage}`,
        actions: ['GET_ORDER_BOOK_DEPTH'],
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
        content: { text: 'Show me the order book depth for token xyz123 on Polymarket.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching order book depth for token xyz123 on Polymarket...',
          action: 'POLYMARKET_GET_ORDER_BOOK_DEPTH',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'What are all the bids and asks for token 0xabc789 via Polymarket?' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Looking up the full order book for token 0xabc789 on Polymarket...',
          action: 'POLYMARKET_GET_ORDER_BOOK_DEPTH',
        },
      },
    ],
  ],
};
