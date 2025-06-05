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

// Define the payload for extracting market and asset ID parameters
export interface CancelMarketOrdersPayload {
  market?: string;
  assetId?: string;
  error?: string;
}

// Define the response structure for the callback data property
export interface CancelMarketOrdersResponseData {
  success: boolean;
  cancelledOrdersCount: number;
  cancelledOrders: string[];
  market?: string;
  assetId?: string;
  message: string;
  timestamp: string;
  error?: string;
}

/**
 * Cancel Market Orders Action for Polymarket CLOB
 * Cancels all orders for a specific market and/or asset ID
 */
export const cancelMarketOrdersAction: Action = {
  name: 'CANCEL_MARKET_ORDERS',
  similes: [
    'CANCEL_MARKET_ORDERS',
    'CANCEL_ORDERS_FOR_MARKET',
    'CANCEL_MARKET_ORDER',
    'CANCEL_ORDERS_IN_MARKET',
    'STOP_MARKET_ORDERS',
    'REMOVE_MARKET_ORDERS',
    'DELETE_MARKET_ORDERS',
    'CANCEL_ALL_ORDERS_FOR_MARKET',
    'CLOSE_MARKET_ORDERS',
    'ABORT_MARKET_ORDERS',
    'CANCEL_ORDERS_BY_MARKET',
    'STOP_ORDERS_FOR_MARKET',
    'CLEAR_MARKET_ORDERS',
    'REMOVE_ORDERS_FROM_MARKET',
    'CANCEL_SPECIFIC_MARKET_ORDERS',
  ],
  description:
    'Cancel all orders for a specific market and/or asset ID on Polymarket CLOB. Requires either a market condition ID, asset ID (token ID), or both parameters.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info('[cancelMarketOrdersAction] Validating action');

    // First check if this message is actually about canceling market orders
    const messageText = message.content?.text?.toLowerCase() || '';
    const cancelKeywords = [
      'cancel',
      'stop',
      'remove',
      'delete',
      'abort',
      'revoke',
      'withdraw',
      'kill',
      'terminate',
      'close',
      'clear',
    ];
    const marketKeywords = ['market', 'orders', 'all orders', 'orders for', 'orders in'];

    const containsCancelKeyword = cancelKeywords.some((keyword) => messageText.includes(keyword));
    const containsMarketKeyword = marketKeywords.some((keyword) => messageText.includes(keyword));

    if (!containsCancelKeyword || !containsMarketKeyword) {
      logger.info(
        '[cancelMarketOrdersAction] Message does not contain cancel and market keywords, rejecting validation'
      );
      return false;
    }

    // Check if CLOB API URL is configured
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');
    if (!clobApiUrl) {
      logger.error('[cancelMarketOrdersAction] CLOB_API_URL is required in configuration');
      return false;
    }

    // Check if we have API credentials
    const apiKey = runtime.getSetting('CLOB_API_KEY');
    const apiSecret = runtime.getSetting('CLOB_API_SECRET') || runtime.getSetting('CLOB_SECRET');
    const apiPassphrase =
      runtime.getSetting('CLOB_API_PASSPHRASE') || runtime.getSetting('CLOB_PASS_PHRASE');

    if (!apiKey || !apiSecret || !apiPassphrase) {
      logger.error(
        '[cancelMarketOrdersAction] Missing required API credentials (CLOB_API_KEY, CLOB_API_SECRET, CLOB_API_PASSPHRASE) in environment.'
      );
      return false;
    }

    // Check if we have private key for signing cancellation requests
    const privateKey =
      runtime.getSetting('POLYMARKET_PRIVATE_KEY') ||
      runtime.getSetting('WALLET_PRIVATE_KEY') ||
      runtime.getSetting('PRIVATE_KEY');

    if (!privateKey) {
      logger.error(
        '[cancelMarketOrdersAction] Missing required private key (POLYMARKET_PRIVATE_KEY, WALLET_PRIVATE_KEY, or PRIVATE_KEY) in environment.'
      );
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
    logger.info('[cancelMarketOrdersAction] Handler called!');

    try {
      // Extract market and asset ID from user message using LLM
      const extractionPrompt = `
Extract the market condition ID and/or asset ID (token ID) from this message about canceling orders for a specific market:
"${message.content.text}"

Extract and return a JSON object with the following fields:
- market: string (optional - the market condition ID, typically a long hex string or market identifier)
- assetId: string (optional - the asset/token ID, typically a long numeric string)

At least one of market or assetId must be provided. Both can be provided if specified.

Examples:
- "Cancel all orders for market 0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af" → {"market": "0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af"}
- "Cancel orders for asset 52114319501245915516055106046884209969926127482827954674443846427813813222426" → {"assetId": "52114319501245915516055106046884209969926127482827954674443846427813813222426"}
- "Cancel all orders in market abc123 for token 456789" → {"market": "abc123", "assetId": "456789"}
- "CANCEL_MARKET_ORDERS market=0x123abc assetId=789def" → {"market": "0x123abc", "assetId": "789def"}

If neither market nor assetId is found or both are "NONE", return {"error": "Missing market or asset ID"}.
Return only the JSON object, no additional text.
`;

      logger.info('[cancelMarketOrdersAction] Starting LLM parameter extraction...');

      const extractedParams = await callLLMWithTimeout(
        runtime,
        state,
        extractionPrompt,
        'cancelMarketOrdersAction',
        10000
      );

      logger.debug(`[cancelMarketOrdersAction] Parsed LLM parameters:`, extractedParams);

      // Handle both string and object responses from LLM
      let orderParams: CancelMarketOrdersPayload;
      if (typeof extractedParams === 'string') {
        try {
          orderParams = JSON.parse(extractedParams);
        } catch (parseError) {
          throw new Error(`Failed to parse LLM response as JSON: ${extractedParams}`);
        }
      } else if (typeof extractedParams === 'object' && extractedParams !== null) {
        orderParams = extractedParams as CancelMarketOrdersPayload;
      } else {
        throw new Error('Invalid response from LLM parameter extraction');
      }

      // Validate extracted parameters
      if (!orderParams || orderParams.error || (!orderParams.market && !orderParams.assetId)) {
        // Try regex fallback for structured input
        const marketPattern =
          /(?:market[=:\s]+)([0-9a-fA-F]{64}|0x[a-fA-F0-9]+|[a-zA-Z0-9\-_]{8,})/i;
        const assetPattern = /(?:asset[_\s]*id[=:\s]+|token[_\s]*id[=:\s]+|asset[=:\s]+)([0-9]+)/i;

        const marketMatch = message.content.text.match(marketPattern);
        const assetMatch = message.content.text.match(assetPattern);

        if (marketMatch || assetMatch) {
          orderParams = {
            market: marketMatch ? marketMatch[1] : undefined,
            assetId: assetMatch ? assetMatch[1] : undefined,
          };
        } else {
          const errorMessage = `❌ **Cancel Market Orders Failed**

**Error**: Please provide a valid market condition ID and/or asset ID (token ID) to cancel orders

**Required Parameters** (at least one):
• **Market ID**: The market condition identifier (typically a long hex string)
• **Asset ID**: The token/asset identifier (typically a long numeric string)

**Examples**:
• "Cancel all orders for market 0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af"
• "Cancel orders for asset 52114319501245915516055106046884209969926127482827954674443846427813813222426"
• "Cancel orders in market abc123 for token 456789"
• "CANCEL_MARKET_ORDERS market=0x123abc assetId=789def"

**How to find Market/Asset IDs**:
You can get these IDs from:
• Market details queries
• Active orders list
• Order placement responses
• Market exploration APIs`;

          const errorContent: Content = {
            text: errorMessage,
            actions: ['CANCEL_MARKET_ORDERS'],
            data: {
              success: false,
              cancelledOrdersCount: 0,
              cancelledOrders: [],
              message: 'Missing market or asset ID',
              timestamp: new Date().toISOString(),
              error: 'Missing market or asset ID',
            } as CancelMarketOrdersResponseData,
          };

          if (callback) {
            await callback(errorContent);
          }
          return errorContent;
        }
      }

      // Initialize CLOB client with credentials
      const client = await initializeClobClientWithCreds(runtime);

      logger.info('[cancelMarketOrdersAction] Cancelling market orders...', {
        market: orderParams.market,
        assetId: orderParams.assetId,
      });

      // Cancel market orders using CLOB client
      const cancelResponse = await client.cancelMarketOrders({
        market: orderParams.market,
        asset_id: orderParams.assetId,
      });

      logger.info('[cancelMarketOrdersAction] Cancel market orders response:', cancelResponse);

      // Handle the response - it may be an array of cancelled order IDs or a success indicator
      let cancelledOrders: string[] = [];
      let cancelledCount = 0;
      let responseMessage = '';

      if (Array.isArray(cancelResponse)) {
        // Response is an array of cancelled order IDs
        cancelledOrders = cancelResponse.map((order) =>
          typeof order === 'string' ? order : order.orderId || order.id || String(order)
        );
        cancelledCount = cancelledOrders.length;
        responseMessage =
          cancelledCount > 0
            ? `Successfully cancelled ${cancelledCount} orders for the specified market`
            : 'No open orders found to cancel for the specified market';
      } else if (cancelResponse && typeof cancelResponse === 'object') {
        // Response is an object with success status
        if (cancelResponse.success !== false) {
          // Handle potential response formats from cancelMarketOrders
          if (cancelResponse.canceled) {
            cancelledOrders = Array.isArray(cancelResponse.canceled) ? cancelResponse.canceled : [];
          } else {
            cancelledOrders = cancelResponse.orderIds || cancelResponse.orders || [];
          }
          cancelledCount = cancelledOrders.length;
          responseMessage =
            cancelResponse.message ||
            (cancelledCount > 0
              ? `Successfully cancelled ${cancelledCount} orders for the specified market`
              : 'No open orders found to cancel for the specified market');
        } else {
          throw new Error(
            cancelResponse.error || cancelResponse.message || 'Failed to cancel market orders'
          );
        }
      } else {
        // Simple success response
        responseMessage = 'All orders for the specified market have been successfully cancelled';
        cancelledCount = 0; // Unknown count
      }

      // Format the response
      const responseData: CancelMarketOrdersResponseData = {
        success: true,
        cancelledOrdersCount: cancelledCount,
        cancelledOrders: cancelledOrders,
        market: orderParams.market,
        assetId: orderParams.assetId,
        message: responseMessage,
        timestamp: new Date().toISOString(),
      };

      // Create success message
      const marketInfo = orderParams.market ? `**Market**: \`${orderParams.market}\`` : '';
      const assetInfo = orderParams.assetId ? `**Asset ID**: \`${orderParams.assetId}\`` : '';
      const targetInfo = [marketInfo, assetInfo].filter(Boolean).join('\n');

      const successMessage = `✅ **Market Orders Cancelled Successfully**

**Cancellation Summary:**
${targetInfo}
• **Orders Cancelled**: ${cancelledCount > 0 ? cancelledCount : 'All matching orders'}
• **Status**: Complete
• **Timestamp**: ${responseData.timestamp}

${
  cancelledOrders.length > 0
    ? `**Cancelled Order IDs:**
${cancelledOrders
  .slice(0, 10)
  .map((id, index) => `${index + 1}. \`${id}\``)
  .join(
    '\n'
  )}${cancelledOrders.length > 10 ? `\n... and ${cancelledOrders.length - 10} more orders` : ''}`
    : ''
}

**Result**: ${responseMessage}

**⚠️ Important Note:**
All matching orders for the specified market/asset have been cancelled. Any partially filled orders will remain as executed, but unfilled portions have been cancelled.`;

      const successContent: Content = {
        text: successMessage,
        actions: ['CANCEL_MARKET_ORDERS'],
        data: responseData,
      };

      if (callback) {
        await callback(successContent);
      }
      return successContent;
    } catch (error: any) {
      logger.error('[cancelMarketOrdersAction] Error cancelling market orders:', error);

      let errorMessage = 'An unexpected error occurred while cancelling market orders.';
      if (error.message) {
        if (error.message.includes('unauthorized') || error.message.includes('authentication')) {
          errorMessage = 'Authentication failed. Please check your API credentials.';
        } else if (error.message.includes('network') || error.message.includes('connection')) {
          errorMessage = 'Network connectivity issues. Please try again in a moment.';
        } else if (error.message.includes('rate limit')) {
          errorMessage = 'Rate limit exceeded. Please wait before trying again.';
        } else if (
          error.message.includes('no orders') ||
          error.message.includes('no open orders')
        ) {
          errorMessage = 'No open orders found to cancel for the specified market.';
        } else if (
          error.message.includes('invalid market') ||
          error.message.includes('market not found')
        ) {
          errorMessage = 'Invalid market ID or asset ID. Please check the provided identifiers.';
        } else {
          errorMessage = error.message;
        }
      }

      const errorContent: Content = {
        text: `❌ **Cancel Market Orders Failed**

**Error**: ${errorMessage}

**Possible Causes:**
• No open orders to cancel for the specified market/asset
• Invalid market condition ID or asset ID
• Authentication or API credential issues
• Network connectivity problems
• Polymarket API rate limiting
• Orders already cancelled or filled

**What to try:**
• Verify the market condition ID and/or asset ID are correct
• Check if there are any open orders for this market first
• Verify your API credentials are valid
• Check network connection and try again
• Wait a moment and retry if rate limited

**Need Help?**
You can check your active orders first or get market details to verify the correct identifiers.`,
        actions: ['CANCEL_MARKET_ORDERS'],
        data: {
          success: false,
          cancelledOrdersCount: 0,
          cancelledOrders: [],
          message: errorMessage,
          timestamp: new Date().toISOString(),
          error: error.message,
        } as CancelMarketOrdersResponseData,
      };

      if (callback) {
        await callback(errorContent);
      }
      return errorContent;
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Cancel all orders for market 0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll cancel all your orders for the specified market. This will cancel all pending orders for that market only.",
          action: 'CANCEL_MARKET_ORDERS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Cancel orders for asset 52114319501245915516055106046884209969926127482827954674443846427813813222426',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll cancel all your orders for the specified asset/token ID.",
          action: 'CANCEL_MARKET_ORDERS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'CANCEL_MARKET_ORDERS market=0x123abc assetId=789def',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll cancel all orders for the specified market and asset combination.",
          action: 'CANCEL_MARKET_ORDERS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Stop all orders in the Trump 2024 market',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll cancel all your orders for that specific market. Please provide the market condition ID for precise cancellation.",
          action: 'CANCEL_MARKET_ORDERS',
        },
      },
    ],
  ],
};
