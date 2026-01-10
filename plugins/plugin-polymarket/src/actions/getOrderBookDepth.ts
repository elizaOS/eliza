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
import { initializeClobClient, type BookParams } from '../utils/clobClient';
import { getOrderBookDepthTemplate } from '../templates';
import type { OrderBook } from '../types';

/**
 * Get order book depth for one or more market tokens action for Polymarket
 * Fetches bid/ask depth data for specified tokens
 */
export const getOrderBookDepthAction: Action = {
  name: 'GET_ORDER_BOOK_DEPTH',
  similes: [
    'ORDER_BOOK_DEPTH',
    'BOOK_DEPTH',
    'GET_DEPTH',
    'SHOW_DEPTH',
    'FETCH_DEPTH',
    'ORDER_DEPTH',
    'DEPTH_DATA',
    'MULTIPLE_BOOKS',
    'BULK_BOOKS',
    'BOOKS_DEPTH',
  ],
  description: 'Retrieve order book depth (bids and asks) for one or more Polymarket tokens',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      logger.warn('[getOrderBookDepthAction] CLOB_API_URL is required but not provided');
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
    logger.info('[getOrderBookDepthAction] Handler called!');

    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      const errorMessage = 'CLOB_API_URL is required in configuration.';
      logger.error(`[getOrderBookDepthAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['GET_ORDER_BOOK_DEPTH'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    let tokenIds: string[] = [];

    // Extract token IDs using LLM
    try {
      const llmResult = await callLLMWithTimeout<{
        tokenIds?: string[];
        query?: string;
        error?: string;
      }>(runtime, state, getOrderBookDepthTemplate, 'getOrderBookDepthAction');

      logger.info('[getOrderBookDepthAction] LLM result:', JSON.stringify(llmResult));

      if (llmResult?.error) {
        const errorMessage =
          'Token identifiers not found. Please specify one or more token IDs for order book depth.';
        logger.error(`[getOrderBookDepthAction] Parameter extraction error: ${errorMessage}`);
        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}

Please provide one or more token IDs in your request. Examples:
• "Show order book depth for token 123456"
• "Get depth for tokens 123456, 789012"
• "ORDER_BOOK_DEPTH 345678 999999"`,
          actions: ['GET_ORDER_BOOK_DEPTH'],
          data: { error: errorMessage },
        };

        if (callback) {
          await callback(errorContent);
        }
        throw new Error(errorMessage);
      }

      tokenIds = llmResult?.tokenIds || [];

      if (!tokenIds || tokenIds.length === 0) {
        // Try to extract from query as fallback
        const fallbackTokens = llmResult?.query || '';
        const matches = fallbackTokens.match(/\d{6,}/g);
        if (matches && matches.length > 0) {
          tokenIds = matches;
        } else {
          throw new Error('No valid token IDs found');
        }
      }

      // Validate token IDs
      const validTokenIds = tokenIds.filter((id) => id && id.match(/^\d+$/));
      if (validTokenIds.length === 0) {
        throw new Error('No valid numeric token IDs found');
      }
      tokenIds = validTokenIds;
    } catch (error) {
      // Check if this is our specific error message and re-throw it
      if (error instanceof Error && error.message.includes('Token identifiers not found')) {
        throw error;
      }

      logger.warn('[getOrderBookDepthAction] LLM extraction failed, trying regex fallback');

      // Regex fallback - try to extract token IDs directly from the message
      const messageText = message.content.text || '';
      const tokenIdMatches = messageText.match(
        /(?:tokens?|TOKEN|ORDER_BOOK_DEPTH)\s*[\s,]*(\d+(?:[\s,]+\d+)*)|(\d{6,}(?:[\s,]+\d{6,})*)/gi
      );

      if (tokenIdMatches) {
        const extractedIds: string[] = [];
        tokenIdMatches.forEach((match) => {
          const ids = match
            .replace(/(?:tokens?|TOKEN|ORDER_BOOK_DEPTH)\s*/gi, '')
            .split(/[\s,]+/)
            .filter((id) => id.match(/^\d{6,}$/));
          extractedIds.push(...ids);
        });

        if (extractedIds.length > 0) {
          tokenIds = extractedIds;
          logger.info(
            `[getOrderBookDepthAction] Regex fallback extracted token IDs: ${tokenIds.join(', ')}`
          );
        }
      }

      if (tokenIds.length === 0) {
        const errorMessage =
          'Unable to extract token IDs from your message. Please provide valid token IDs.';
        logger.error('[getOrderBookDepthAction] Token extraction failed:', error);

        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}

Please provide one or more token IDs in your request. Examples:
• "Show order book depth for token 123456"
• "Get depth for tokens 123456, 789012"
• "ORDER_BOOK_DEPTH 345678 999999"`,
          actions: ['GET_ORDER_BOOK_DEPTH'],
          data: { error: errorMessage },
        };

        if (callback) {
          await callback(errorContent);
        }
        throw new Error(errorMessage);
      }
    }

    try {
      // Initialize CLOB client
      const clobClient = await initializeClobClient(runtime);

      // Prepare book parameters
      const bookParams: BookParams[] = tokenIds.map((tokenId) => ({ token_id: tokenId }));

      // Fetch order book data
      const orderBooks: OrderBook[] = await clobClient.getOrderBooks(bookParams);

      if (!orderBooks || orderBooks.length === 0) {
        throw new Error(`No order books found for the provided token IDs: ${tokenIds.join(', ')}`);
      }

      // Format response text
      let responseText = `📊 **Order Book Depth Summary**\n\n`;
      responseText += `**Tokens Requested**: ${tokenIds.length}\n`;
      responseText += `**Order Books Found**: ${orderBooks.length}\n\n`;

      // Process each order book
      orderBooks.forEach((orderBook, index) => {
        const bidCount = orderBook.bids?.length || 0;
        const askCount = orderBook.asks?.length || 0;
        const bestBid = bidCount > 0 ? orderBook.bids[0] : null;
        const bestAsk = askCount > 0 ? orderBook.asks[0] : null;

        responseText += `**Token ${index + 1}: \`${orderBook.asset_id}\`**\n`;
        responseText += `• Market: ${orderBook.market || 'N/A'}\n`;
        responseText += `• Bid Levels: ${bidCount}\n`;
        responseText += `• Ask Levels: ${askCount}\n`;

        if (bestBid) {
          responseText += `• Best Bid: $${bestBid.price} (${bestBid.size})\n`;
        } else {
          responseText += `• Best Bid: No bids\n`;
        }

        if (bestAsk) {
          responseText += `• Best Ask: $${bestAsk.price} (${bestAsk.size})\n`;
        } else {
          responseText += `• Best Ask: No asks\n`;
        }

        responseText += `\n`;
      });

      // Summary statistics
      const totalBids = orderBooks.reduce((sum, book) => sum + (book.bids?.length || 0), 0);
      const totalAsks = orderBooks.reduce((sum, book) => sum + (book.asks?.length || 0), 0);
      const activeBooks = orderBooks.filter(
        (book) => (book.bids?.length || 0) > 0 || (book.asks?.length || 0) > 0
      ).length;

      responseText += `**Summary**:\n`;
      responseText += `• Active Order Books: ${activeBooks}/${orderBooks.length}\n`;
      responseText += `• Total Bid Levels: ${totalBids}\n`;
      responseText += `• Total Ask Levels: ${totalAsks}\n`;

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYMARKET_GET_ORDER_BOOK_DEPTH'],
        data: {
          orderBooks,
          tokenIds,
          summary: {
            tokensRequested: tokenIds.length,
            orderBooksFound: orderBooks.length,
            activeBooks,
            totalBids,
            totalAsks,
          },
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      logger.error('[getOrderBookDepthAction] Error fetching order books:', error);

      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Unknown error occurred while fetching order books';
      const errorContent: Content = {
        text: `❌ **Error retrieving order book depth**: ${errorMessage}

Please check:
• The token IDs are valid and exist
• CLOB_API_URL is correctly configured
• Network connectivity is available
• Polymarket CLOB service is operational

**Token IDs provided**: \`${tokenIds.join(', ')}\``,
        actions: ['POLYMARKET_GET_ORDER_BOOK_DEPTH'],
        data: {
          error: errorMessage,
          tokenIds,
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
          text: 'Show order book depth for token 123456 via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll fetch the order book depth data for that token via Polymarket.",
          actions: ['POLYMARKET_GET_ORDER_BOOK_DEPTH'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Get depth for tokens 123456, 789012 via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me get the order book depth for those tokens via Polymarket.',
          actions: ['POLYMARKET_GET_ORDER_BOOK_DEPTH'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'ORDER_BOOK_DEPTH 345678 999999 via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching order book depth data for multiple tokens via Polymarket.',
          actions: ['POLYMARKET_GET_ORDER_BOOK_DEPTH'],
        },
      },
    ],
  ],
};
