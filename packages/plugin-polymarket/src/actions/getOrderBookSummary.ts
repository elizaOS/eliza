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
import { getOrderBookTemplate } from '../templates';
import type { OrderBook } from '../types';

/**
 * Get order book summary for a market token action for Polymarket
 * Fetches bid/ask data for a specific token
 */
export const getOrderBookSummaryAction: Action = {
  name: 'GET_ORDER_BOOK',
  similes: [
    'ORDER_BOOK_SUMMARY',
    'ORDERBOOK_SUMMARY',
    'BOOK_SUMMARY',
    'ORDER_BOOK_DATA',
    'ORDERBOOK_DATA',
    'BID_ASK_DATA',
    'MARKET_DEPTH',
    'TRADING_BOOK',
    'DEPTH_CHART',
    'MARKET_BOOK',
  ],
  description:
    'Retrieve order book summary (bids and asks) for a specific Polymarket TOKEN (not for individual orders). This shows market depth and trading prices for a token. Use this only when someone asks for order book, market depth, or trading data for a token ID.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      logger.warn('[getOrderBookSummaryAction] CLOB_API_URL is required but not provided');
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
    logger.info('[getOrderBookSummaryAction] Handler called!');

    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      const errorMessage = 'CLOB_API_URL is required in configuration.';
      logger.error(`[getOrderBookSummaryAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['GET_ORDER_BOOK'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    let tokenId = '';

    // Extract token ID using LLM
    try {
      const llmResult = await callLLMWithTimeout<{
        tokenId?: string;
        query?: string;
        error?: string;
      }>(runtime, state, getOrderBookTemplate, 'getOrderBookSummaryAction');

      logger.info('[getOrderBookSummaryAction] LLM result:', JSON.stringify(llmResult));

      if (llmResult?.error) {
        const errorMessage =
          'Token identifier not found. Please specify a token ID for the order book.';
        logger.error(`[getOrderBookSummaryAction] Parameter extraction error: ${errorMessage}`);
        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}

Please provide a token ID in your request. Here are comprehensive examples:

**📖 BASIC ORDER BOOK QUERIES:**
• "Show order book for token 123456"
• "Get order book summary for 789012"
• "Order book for token 456789"
• "Display order book 321654"
• "ORDER_BOOK 987654"
• "Book summary for 555666"

**⚡ QUICK ORDER BOOK FORMATS:**
• "Book 123456"
• "OrderBook 789012"
• "OB 456789"
• "Summary 321654"
• "Depth 987654"
• "Market depth 555666"

**🔍 DETAILED ORDER BOOK QUERIES:**
• "Show me the full order book for token 123456"
• "Get complete market depth for token 789012"
• "Display buy and sell orders for token 456789"
• "Show order book with bids and asks for 321654"
• "Get market liquidity for token 987654"
• "Order book analysis for token 555666"

**📊 MARKET DEPTH QUERIES:**
• "Show market depth for token 123456"
• "Get bid-ask spread for token 789012"
• "Display liquidity for token 456789"
• "Market depth analysis for 321654"
• "Order book depth for 987654"
• "Liquidity summary for 555666"

**🎯 CONTEXT-AWARE QUERIES:**
• "Show order book for Bitcoin prediction token 123456"
• "Get order book for election market 789012"
• "Order book for sports betting token 456789"
• "Display order book for crypto market 321654"
• "Weather prediction order book 987654"

**📋 STRUCTURED QUERIES:**
• "ORDER_BOOK tokenId: 123456"
• "Get book { token: 789012 }"
• "Order book = 456789"
• "Show token_id: 321654"
• "Book(987654)"

**🔢 TOKEN ID EXAMPLES:**
• 6-digit IDs: "Order book 123456"
• 8-digit IDs: "Book summary 12345678"
• Long numeric: "Show book 123456789012"
• Hex format: "Order book 0x123abc"

**📈 WHAT YOU'LL SEE:**
Order book summary includes:
• Token and market information
• Total number of bid/ask orders
• Best bid and ask prices with sizes
• Bid-ask spread calculation
• Total liquidity on both sides
• Top 5 bids and asks
• Market depth analysis
• Real-time pricing data

**💡 Pro Tips:**
• Order books show all available orders, not just yours
• Best bid = highest buy price, Best ask = lowest sell price
• Spread = difference between best bid and ask
• Higher liquidity = better price execution
• Use this to analyze market sentiment and pricing`,
          actions: ['GET_ORDER_BOOK'],
          data: { error: errorMessage },
        };

        if (callback) {
          await callback(errorContent);
        }
        throw new Error(errorMessage);
      }

      tokenId = llmResult?.tokenId || '';

      if (!tokenId || tokenId.trim() === '') {
        // Try to extract from query as fallback
        const fallbackId = llmResult?.query || '';
        if (fallbackId && fallbackId.match(/^\d+$/)) {
          tokenId = fallbackId;
        } else {
          throw new Error('No valid token ID found');
        }
      }
    } catch (error) {
      // Check if this is our specific error message and re-throw it
      if (
        error instanceof Error &&
        error.message ===
          'Token identifier not found. Please specify a token ID for the order book.'
      ) {
        throw error;
      }

      logger.warn('[getOrderBookSummaryAction] LLM extraction failed, trying regex fallback');

      // Regex fallback - try to extract token ID directly from the message
      const messageText = message.content.text || '';
      const tokenIdMatch = messageText.match(
        /(?:token|TOKEN)\s*(\d+)|ORDER_BOOK\s*(\d+)|(\d{6,})/i
      );

      if (tokenIdMatch) {
        tokenId = tokenIdMatch[1] || tokenIdMatch[2] || tokenIdMatch[3];
        logger.info(`[getOrderBookSummaryAction] Regex fallback extracted token ID: ${tokenId}`);
      } else {
        const errorMessage =
          'Unable to extract token ID from your message. Please provide a valid token ID.';
        logger.error('[getOrderBookSummaryAction] LLM parameter extraction failed:', error);

        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}

Please provide a token ID in your request. Here are comprehensive examples:

**📖 BASIC ORDER BOOK QUERIES:**
• "Show order book for token 123456"
• "Get order book summary for 789012"
• "Order book for token 456789"
• "Display order book 321654"
• "ORDER_BOOK 987654"
• "Book summary for 555666"

**⚡ QUICK ORDER BOOK FORMATS:**
• "Book 123456"
• "OrderBook 789012"
• "OB 456789"
• "Summary 321654"
• "Depth 987654"
• "Market depth 555666"

**🔍 DETAILED ORDER BOOK QUERIES:**
• "Show me the full order book for token 123456"
• "Get complete market depth for token 789012"
• "Display buy and sell orders for token 456789"
• "Show order book with bids and asks for 321654"
• "Get market liquidity for token 987654"
• "Order book analysis for token 555666"

**📊 MARKET DEPTH QUERIES:**
• "Show market depth for token 123456"
• "Get bid-ask spread for token 789012"
• "Display liquidity for token 456789"
• "Market depth analysis for 321654"
• "Order book depth for 987654"
• "Liquidity summary for 555666"

**🎯 CONTEXT-AWARE QUERIES:**
• "Show order book for Bitcoin prediction token 123456"
• "Get order book for election market 789012"
• "Order book for sports betting token 456789"
• "Display order book for crypto market 321654"
• "Weather prediction order book 987654"

**📋 STRUCTURED QUERIES:**
• "ORDER_BOOK tokenId: 123456"
• "Get book { token: 789012 }"
• "Order book = 456789"
• "Show token_id: 321654"
• "Book(987654)"

**🔢 TOKEN ID EXAMPLES:**
• 6-digit IDs: "Order book 123456"
• 8-digit IDs: "Book summary 12345678"
• Long numeric: "Show book 123456789012"
• Hex format: "Order book 0x123abc"

**📈 WHAT YOU'LL SEE:**
Order book summary includes:
• Token and market information
• Total number of bid/ask orders
• Best bid and ask prices with sizes
• Bid-ask spread calculation
• Total liquidity on both sides
• Top 5 bids and asks
• Market depth analysis
• Real-time pricing data

**💡 Pro Tips:**
• Order books show all available orders, not just yours
• Best bid = highest buy price, Best ask = lowest sell price
• Spread = difference between best bid and ask
• Higher liquidity = better price execution
• Use this to analyze market sentiment and pricing`,
          actions: ['GET_ORDER_BOOK'],
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

      // Fetch order book data
      const orderBook: OrderBook = await clobClient.getOrderBook(tokenId);

      if (!orderBook) {
        throw new Error(`Order book not found for token ID: ${tokenId}`);
      }

      // Calculate summary statistics
      const bidCount = orderBook.bids?.length || 0;
      const askCount = orderBook.asks?.length || 0;
      const bestBid = bidCount > 0 ? orderBook.bids[0] : null;
      const bestAsk = askCount > 0 ? orderBook.asks[0] : null;
      const spread =
        bestBid && bestAsk
          ? (parseFloat(bestAsk.price) - parseFloat(bestBid.price)).toFixed(4)
          : 'N/A';

      // Calculate total bid/ask sizes
      const totalBidSize = orderBook.bids?.reduce((sum, bid) => sum + parseFloat(bid.size), 0) || 0;
      const totalAskSize = orderBook.asks?.reduce((sum, ask) => sum + parseFloat(ask.size), 0) || 0;

      // Format response text
      let responseText = `📖 **Order Book Summary**\n\n`;

      responseText += `**Token Information:**\n`;
      responseText += `• Token ID: \`${tokenId}\`\n`;
      responseText += `• Market: ${orderBook.market || 'N/A'}\n`;
      responseText += `• Asset ID: ${orderBook.asset_id || 'N/A'}\n\n`;

      responseText += `**Market Depth:**\n`;
      responseText += `• Bid Orders: ${bidCount}\n`;
      responseText += `• Ask Orders: ${askCount}\n`;
      responseText += `• Total Bid Size: ${totalBidSize.toFixed(2)}\n`;
      responseText += `• Total Ask Size: ${totalAskSize.toFixed(2)}\n\n`;

      responseText += `**Best Prices:**\n`;
      if (bestBid) {
        responseText += `• Best Bid: $${bestBid.price} (Size: ${bestBid.size})\n`;
      } else {
        responseText += `• Best Bid: No bids available\n`;
      }

      if (bestAsk) {
        responseText += `• Best Ask: $${bestAsk.price} (Size: ${bestAsk.size})\n`;
      } else {
        responseText += `• Best Ask: No asks available\n`;
      }

      responseText += `• Spread: ${spread === 'N/A' ? 'N/A' : '$' + spread}\n\n`;

      // Show top 5 bids and asks
      if (bidCount > 0) {
        responseText += `**Top 5 Bids:**\n`;
        orderBook.bids.slice(0, 5).forEach((bid, index) => {
          responseText += `${index + 1}. $${bid.price} - Size: ${bid.size}\n`;
        });
        responseText += `\n`;
      }

      if (askCount > 0) {
        responseText += `**Top 5 Asks:**\n`;
        orderBook.asks.slice(0, 5).forEach((ask, index) => {
          responseText += `${index + 1}. $${ask.price} - Size: ${ask.size}\n`;
        });
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['GET_ORDER_BOOK'],
        data: {
          orderBook,
          tokenId,
          summary: {
            bidCount,
            askCount,
            bestBid,
            bestAsk,
            spread,
            totalBidSize,
            totalAskSize,
          },
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      logger.error('[getOrderBookSummaryAction] Error fetching order book:', error);

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred while fetching order book';
      const errorContent: Content = {
        text: `❌ **Error retrieving order book**: ${errorMessage}

Please check:
• The token ID is valid and exists
• CLOB_API_URL is correctly configured
• Network connectivity is available
• Polymarket CLOB service is operational

**Token ID provided**: \`${tokenId}\``,
        actions: ['GET_ORDER_BOOK'],
        data: {
          error: errorMessage,
          tokenId,
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
          text: 'Show order book for token 123456',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll fetch the order book data for token 123456.",
          actions: ['GET_ORDER_BOOK'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Get order book summary for token 789012',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me get the order book summary for token 789012.',
          actions: ['GET_ORDER_BOOK'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'ORDER_BOOK_SUMMARY 345678',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching order book data for token 345678.',
          actions: ['GET_ORDER_BOOK'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Show market depth for token 999999',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Getting market depth for token 999999.',
          actions: ['GET_ORDER_BOOK'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Get trading book for token 555555',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Retrieving trading book for token 555555.',
          actions: ['GET_ORDER_BOOK'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Show bids and asks for token 777777',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Getting bid and ask data for token 777777.',
          actions: ['GET_ORDER_BOOK'],
        },
      },
    ],
  ],
};
