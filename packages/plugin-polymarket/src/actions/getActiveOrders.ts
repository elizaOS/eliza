import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from '@elizaos/core';
import { callLLMWithTimeout } from '../utils/llmHelpers';
import { initializeClobClientWithCreds } from '../utils/clobClient';
import type { ClobClient } from '@polymarket/clob-client';
import { getActiveOrdersTemplate } from '../templates';
import type { OpenOrder, GetOpenOrdersParams as LocalGetOpenOrdersParams } from '../types';

// Updated interface to match actual Polymarket API response
interface PolymarketOrderResponse {
  id: string;
  status: string;
  owner: string;
  maker_address: string;
  market: string;
  asset_id: string;
  side: string;
  original_size: string;
  size_matched: string;
  price: string;
  outcome: string;
  expiration: string;
  order_type: string;
  associate_trades: any[];
  created_at: number; // Unix timestamp
  updated_at?: number; // Unix timestamp
  fees_paid?: string;
  error_code?: string | null;
  error_message?: string | null;
}

/**
 * Get active orders for a specific market and optionally asset ID.
 */
export const getActiveOrdersAction: Action = {
  name: 'GET_ACTIVE_ORDERS',
  similes: [
    'GET_ACTIVE_ORDERS',
    'ACTIVE_ORDERS',
    'ACTIVE_ORDERS_FOR_MARKET',
    'OPEN_ORDERS_MARKET',
    'LIST_MARKET_ORDERS',
    'SHOW_OPEN_BIDS_ASKS',
    'MARKET_ACTIVE_ORDERS',
    'SHOW_ACTIVE_ORDERS',
    'GET_OPEN_ORDERS',
    'FETCH_ACTIVE_ORDERS',
    'RETRIEVE_ACTIVE_ORDERS',
    'LIST_ACTIVE_ORDERS',
    'ACTIVE_ORDERS_LIST',
    'OPEN_ORDERS_LIST',
    'MARKET_ORDERS_ACTIVE',
    'GET_MARKET_ORDERS',
    'SHOW_MARKET_ORDERS',
    'FETCH_MARKET_ORDERS',
    'LIST_OPEN_ORDERS',
    'ACTIVE_MARKET_ORDERS',
    'OPEN_MARKET_ORDERS',
  ],
  description:
    'Retrieves active (open) orders for a specified market and, optionally, a specific asset ID (token). This shows YOUR LIVE ORDERS in a market, not the order book depth. Use this when someone asks for "active orders", "open orders", "market orders", or "orders for market". This is different from order book which shows market depth.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info(`[getActiveOrdersAction] Validate called for message: "${message.content?.text}"`);
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');
    const clobApiKey = runtime.getSetting('CLOB_API_KEY');
    const clobApiSecret =
      runtime.getSetting('CLOB_API_SECRET') || runtime.getSetting('CLOB_SECRET');
    const clobApiPassphrase =
      runtime.getSetting('CLOB_API_PASSPHRASE') || runtime.getSetting('CLOB_PASS_PHRASE');
    const privateKey =
      runtime.getSetting('WALLET_PRIVATE_KEY') ||
      runtime.getSetting('PRIVATE_KEY') ||
      runtime.getSetting('POLYMARKET_PRIVATE_KEY');

    if (!clobApiUrl) {
      logger.warn('[getActiveOrdersAction] CLOB_API_URL is required');
      return false;
    }
    if (!privateKey) {
      logger.warn(
        '[getActiveOrdersAction] A private key (WALLET_PRIVATE_KEY, PRIVATE_KEY, or POLYMARKET_PRIVATE_KEY) is required.'
      );
      return false;
    }
    if (!clobApiKey || !clobApiSecret || !clobApiPassphrase) {
      const missing = [];
      if (!clobApiKey) missing.push('CLOB_API_KEY');
      if (!clobApiSecret) missing.push('CLOB_API_SECRET or CLOB_SECRET');
      if (!clobApiPassphrase) missing.push('CLOB_API_PASSPHRASE or CLOB_PASS_PHRASE');
      logger.warn(
        `[getActiveOrdersAction] Missing required API credentials for L2 authentication: ${missing.join(', ')}.`
      );
      return false;
    }
    logger.info('[getActiveOrdersAction] Validation passed');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getActiveOrdersAction] Handler called!');

    let extractedParams: {
      marketId?: string;
      assetId?: string;
      error?: string;
    } = {};

    try {
      extractedParams = await callLLMWithTimeout<typeof extractedParams>(
        runtime,
        state,
        getActiveOrdersTemplate,
        'getActiveOrdersAction'
      );
      logger.info(`[getActiveOrdersAction] LLM result: ${JSON.stringify(extractedParams)}`);

      if (extractedParams.error || !extractedParams.marketId) {
        throw new Error(extractedParams.error || 'Market ID not found in LLM result.');
      }
    } catch (error) {
      logger.warn('[getActiveOrdersAction] LLM extraction failed, trying regex fallback', error);
      const text = message.content?.text || '';
      const marketRegex = /(?:market|marketId|condition_id)[:\s]?([0-9a-zA-Z_.-]+)/i;
      const assetRegex = /(?:asset|assetId|token_id)[:\s]?([0-9a-zA-Z_.-]+)/i;

      const marketMatch = text.match(marketRegex);
      if (marketMatch && marketMatch[1]) {
        extractedParams.marketId = marketMatch[1];
      }
      const assetMatch = text.match(assetRegex);
      if (assetMatch && assetMatch[1]) {
        extractedParams.assetId = assetMatch[1];
      }

      if (!extractedParams.marketId) {
        const errorMessage = 'Please specify a Market ID to get active orders.';
        logger.error(`[getActiveOrdersAction] Market ID extraction failed. Text: "${text}"`);
        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}

Please provide a Market ID to retrieve active orders. Here are comprehensive examples:

**📊 BASIC ACTIVE ORDERS QUERIES:**
• "Show active orders for market 123456"
• "Get my open orders for market 789012"
• "List active orders in market 456789"
• "What are my current orders for market 321654"
• "Display open orders for market 987654"
• "Check active orders in market 555666"

**🎯 MARKET + ASSET SPECIFIC:**
• "Show active orders for market 123456 asset 0x1234abcd"
• "Get open orders for market 789012 token 0x5678efgh"
• "List my orders in market 456789 for asset 0x9abc1234"
• "Active orders for market 321654 and token ID 0x5678dcba"

**🔍 DETAILED QUERIES:**
• "Show all my active orders for prediction market 123456"
• "Get open buy and sell orders for market 789012"
• "List current limit orders in market 456789"
• "What orders do I have active in market 321654?"
• "Display my pending orders for market 987654"
• "Check open positions in market 555666"

**📈 MARKET CONTEXT QUERIES:**
• "Show my active orders for Bitcoin price prediction market 123456"
• "Get open orders for election market 789012"
• "List active trades in sports betting market 456789"
• "Active orders for weather prediction market 321654"
• "My current positions in crypto market 987654"

**⚡ QUICK QUERIES:**
• "Active orders 123456"
• "Open orders market 789012"
• "Orders for 456789"
• "Market 321654 active"
• "Open 987654"

**🔢 DIFFERENT ID FORMATS:**
• "Active orders for market ID: 123456789012"
• "Show orders for condition_id 0x1234567890abcdef"
• "Get orders market: 789abc012def"
• "Active orders marketId=456789012345"

**📋 RESPONSE DETAILS:**
This command shows YOUR active orders (not the market order book):
• Order ID and status
• Buy/Sell side and amounts
• Limit prices and order types
• Creation and update timestamps
• Remaining size and matched amounts
• Market and asset information

**💡 Pro Tips:**
• Market IDs are typically 6+ digit numbers or hex strings
• Asset IDs are optional - if not specified, shows all assets in market
• Use this to track your own orders, not to see market depth
• For order book depth, use GET_ORDER_BOOK_SUMMARY instead`,
          actions: ['GET_ACTIVE_ORDERS'],
          data: { error: errorMessage },
        };
        if (callback) await callback(errorContent);
        throw new Error(errorMessage);
      }
    }

    const apiParams: LocalGetOpenOrdersParams = {
      market: extractedParams.marketId,
      assetId: extractedParams.assetId,
      // nextCursor and address can be added if needed from LLM or settings
    };

    // Remove undefined properties
    Object.keys(apiParams).forEach((key) => {
      const K = key as keyof LocalGetOpenOrdersParams;
      if (apiParams[K] === undefined) delete apiParams[K];
    });

    logger.info(
      `[getActiveOrdersAction] Attempting to fetch open orders for Market ID: ${apiParams.market}, Asset ID: ${apiParams.assetId || 'any'}`
    );

    try {
      const client = (await initializeClobClientWithCreds(runtime)) as ClobClient;

      // The official client's getOpenOrders might return OpenOrdersResponse or OpenOrder[]
      // For now, casting to any and then to OpenOrder[] to match previous logic.
      // The official client's OpenOrderParams type should be used for apiParams if different.
      const openOrdersResponse: any = await client.getOpenOrders(apiParams as any);

      // Determine if the response is an array directly or an object with a data field
      let actualOrders: OpenOrder[];
      let nextCursor: string | undefined;

      if (Array.isArray(openOrdersResponse)) {
        actualOrders = openOrdersResponse;
        // If it's just an array, pagination info might be lost or handled differently by official client
      } else if (openOrdersResponse && Array.isArray(openOrdersResponse.data)) {
        actualOrders = openOrdersResponse.data;
        nextCursor = openOrdersResponse.next_cursor;
      } else {
        // Fallback if structure is unexpected, treat as empty or handle error
        actualOrders = [];
        logger.warn(
          '[getActiveOrdersAction] Unexpected response structure from client.getOpenOrders'
        );
      }

      let responseText = `📊 **Active Orders for Market ${apiParams.market}**`;
      if (apiParams.assetId) {
        responseText += ` (Asset ${apiParams.assetId})`;
      }
      responseText += `\n\n`;

      if (actualOrders.length > 0) {
        responseText += actualOrders
          .map((order) => {
            // Cast to the actual Polymarket API response type
            const polyOrder = order as any as PolymarketOrderResponse;

            // Fix field mappings to match actual Polymarket API response
            const orderId = polyOrder.id || 'Unknown';
            const side = polyOrder.side || 'Unknown';
            const price = polyOrder.price || 'Unknown';
            const originalSize = polyOrder.original_size || 'Unknown';
            const sizeMatched = polyOrder.size_matched || '0';
            const status = polyOrder.status || 'Unknown';

            // Handle Unix timestamp conversion properly
            const createdAt =
              polyOrder.created_at && typeof polyOrder.created_at === 'number'
                ? new Date(polyOrder.created_at * 1000).toLocaleString()
                : 'Unknown';

            return (
              `• **Order ID**: ${orderId}\n` +
              `  ◦ **Side**: ${side}\n` +
              `  ◦ **Price**: ${price}\n` +
              `  ◦ **Size**: ${originalSize}\n` +
              `  ◦ **Filled**: ${sizeMatched}\n` +
              `  ◦ **Status**: ${status}\n` +
              `  ◦ **Created**: ${createdAt}`
            );
          })
          .join('\n\n');
        if (nextCursor && nextCursor !== 'LTE=') {
          responseText += `\n\n🗒️ *More orders available. Use cursor \`${nextCursor}\` to fetch next page.*`;
        }
      } else {
        responseText += `No active orders found for Market ID ${apiParams.market}`;
        if (apiParams.assetId) {
          responseText += ` and Asset ID ${apiParams.assetId}`;
        }
        responseText += `.`;
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['GET_ACTIVE_ORDERS'],
        data: {
          ...apiParams,
          orders: actualOrders,
          nextCursor,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[getActiveOrdersAction] Error fetching active orders:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error fetching active orders for market ${apiParams.market}**: ${errorMessage}`,
        actions: ['GET_ACTIVE_ORDERS'],
        data: { error: errorMessage, ...apiParams, timestamp: new Date().toISOString() },
      };
      if (callback) await callback(errorContent);
      throw error;
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Get active orders for market 0x04303515e58b871fc6b95e31c58bf7c74aa8c8e4eb4c1378d135086cf265c8f2',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll fetch the active orders for that market.",
          actions: ['GET_ACTIVE_ORDERS'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Show me the active orders for market 0x123abc and asset 0xTokenYes.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Okay, fetching active orders for market 0x123abc, asset 0xTokenYes.',
          actions: ['GET_ACTIVE_ORDERS'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'What are the open orders on market condition_id_polymarket?' },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll get the open orders for market condition_id_polymarket.",
          actions: ['GET_ACTIVE_ORDERS'],
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'List active orders for market 0xMarket123' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Retrieving active orders for market 0xMarket123.',
          actions: ['GET_ACTIVE_ORDERS'],
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'Show active orders in market 0xABC123' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Getting active orders for market 0xABC123.',
          actions: ['GET_ACTIVE_ORDERS'],
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'Get open orders for market 0x456def' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching open orders for market 0x456def.',
          actions: ['GET_ACTIVE_ORDERS'],
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'Fetch active orders from market 0x789ghi' } },
      {
        name: '{{user2}}',
        content: {
          text: "I'll retrieve the active orders from market 0x789ghi.",
          actions: ['GET_ACTIVE_ORDERS'],
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'What orders are active on market 0xJKL012?' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Checking active orders on market 0xJKL012.',
          actions: ['GET_ACTIVE_ORDERS'],
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'Display open orders for market condition_xyz789' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Displaying open orders for market condition_xyz789.',
          actions: ['GET_ACTIVE_ORDERS'],
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'List market orders for 0xMarket456' } },
      {
        name: '{{user2}}',
        content: { text: 'Listing market orders for 0xMarket456.', actions: ['GET_ACTIVE_ORDERS'] },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'Show all active orders in market 0x999ABC' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Showing all active orders in market 0x999ABC.',
          actions: ['GET_ACTIVE_ORDERS'],
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'ACTIVE_ORDERS market 0x111BBB' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Getting active orders for market 0x111BBB.',
          actions: ['GET_ACTIVE_ORDERS'],
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'GET_ACTIVE_ORDERS 0x222CCC' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Retrieving active orders for market 0x222CCC.',
          actions: ['GET_ACTIVE_ORDERS'],
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'Retrieve active orders market 0x333DDD' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Retrieving active orders for market 0x333DDD.',
          actions: ['GET_ACTIVE_ORDERS'],
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'Find active orders on market 0x444EEE' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Finding active orders on market 0x444EEE.',
          actions: ['GET_ACTIVE_ORDERS'],
        },
      },
    ],
  ],
};
