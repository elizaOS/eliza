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
import { getOrderDetailsTemplate } from '../templates';
import type { OrderSide, OrderStatus } from '../types';

// Updated interface to match actual Polymarket API response
interface PolymarketOrderResponse {
  id: string;
  status: string;
  owner: string;
  maker_address: string;
  market: string;
  asset_id: string;
  side: OrderSide;
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
 * Get order details by ID action for Polymarket.
 * Fetches detailed information for a specific order.
 */
export const getOrderDetailsAction: Action = {
  name: 'GET_ORDER_DETAILS',
  similes: [
    'ORDER_DETAILS',
    'GET_ORDER_DETAILS',
    'FETCH_ORDER_DETAILS',
    'SHOW_ORDER_DETAILS',
    'ORDER_INFORMATION',
    'ORDER_STATUS_DETAILS',
    'CHECK_ORDER_DETAILS',
    'VIEW_ORDER_DETAILS',
    'LOOK_UP_ORDER_DETAILS',
    'FIND_ORDER_DETAILS',
    'DISPLAY_ORDER_DETAILS',
    'RETRIEVE_ORDER_DETAILS',
    'ORDER_LOOKUP',
    'ORDER_INQUIRY',
    'ORDER_STATUS_CHECK',
    'GET_ORDER_INFO',
    'FETCH_ORDER_INFO',
    'SHOW_ORDER_INFO',
    'ORDER_STATUS',
    'GET_ORDER',
    'FETCH_ORDER',
    'VIEW_ORDER',
    'LOOK_UP_ORDER',
    'FIND_ORDER',
    'DISPLAY_ORDER',
    'RETRIEVE_ORDER',
    'CHECK_ORDER',
  ],
  description:
    'Get detailed information for a specific ORDER by its ORDER ID (64-character hex strings starting with 0x). This action retrieves order status, fill information, pricing, and eligibility for rewards. Use this for any request about a specific order.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info(`[getOrderDetailsAction] Validate called for message: "${message.content?.text}"`);
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');
    const privateKey =
      runtime.getSetting('WALLET_PRIVATE_KEY') ||
      runtime.getSetting('PRIVATE_KEY') ||
      runtime.getSetting('POLYMARKET_PRIVATE_KEY');

    if (!clobApiUrl) {
      logger.warn('[getOrderDetailsAction] CLOB_API_URL is required');
      return false;
    }
    if (!privateKey) {
      logger.warn(
        '[getOrderDetailsAction] A private key (WALLET_PRIVATE_KEY, PRIVATE_KEY, or POLYMARKET_PRIVATE_KEY) is required.'
      );
      return false;
    }

    // Check for API credentials but don't fail if missing - will try to authenticate at runtime
    const clobApiKey = runtime.getSetting('CLOB_API_KEY');
    const clobApiSecret =
      runtime.getSetting('CLOB_API_SECRET') || runtime.getSetting('CLOB_SECRET');
    const clobApiPassphrase =
      runtime.getSetting('CLOB_API_PASSPHRASE') || runtime.getSetting('CLOB_PASS_PHRASE');

    if (!clobApiKey || !clobApiSecret || !clobApiPassphrase) {
      logger.info(
        '[getOrderDetailsAction] Some API credentials missing, will attempt authentication at runtime'
      );
    }

    logger.info('[getOrderDetailsAction] Validation passed');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getOrderDetailsAction] Handler called!');

    let orderId: string | undefined;
    try {
      const llmResult = await callLLMWithTimeout<{ orderId?: string; error?: string }>(
        runtime,
        state,
        getOrderDetailsTemplate,
        'getOrderDetailsAction'
      );
      logger.info(`[getOrderDetailsAction] LLM result: ${JSON.stringify(llmResult)}`);
      if (llmResult?.error || !llmResult?.orderId) {
        throw new Error(llmResult?.error || 'Order ID not found in LLM result.');
      }
      orderId = llmResult.orderId;
    } catch (error) {
      logger.warn('[getOrderDetailsAction] LLM extraction failed, trying regex fallback');
      const text = message.content?.text || '';
      const orderIdRegex = /(?:order|ID)[:\s#]?(0x[0-9a-fA-F]{64}|[0-9a-zA-Z_\-]+)/i;
      const match = text.match(orderIdRegex);
      if (match && match[1]) {
        orderId = match[1];
      } else {
        const errorMessage = 'Please specify an Order ID to get details.';
        logger.error(`[getOrderDetailsAction] Order ID extraction failed. Text: "${text}"`);
        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}

Please provide an Order ID to retrieve detailed order information. Here are comprehensive examples:

**🔍 BASIC ORDER DETAILS QUERIES:**
• "Get details for order 0x41483bba4be4734faf3cd6810e76d81023318267f7a5210f95141dbe91398245"
• "Show me order details for abc123def456"
• "Order details for 789xyz012abc"
• "Details for order order-123-456-789"
• "Get order info for 456789012345"
• "Show order status for myOrderID_123"

**⚡ QUICK LOOKUP FORMATS:**
• "Details 0x1234567890abcdef"
• "Status abc123"
• "Info 789xyz"
• "Order order-123"
• "Details for 456789"
• "Check xyz789"

**🔍 DETAILED QUERIES:**
• "Show me the full details for order 0x41483bba4be4734faf3cd6810e76d81023318267f7a5210f95141dbe91398245"
• "Get complete order information for abc123def456789"
• "Display order status and details for 789xyz012abc456"
• "Retrieve all information for order order-123-456-789"
• "Show order history for 456789012345678"
• "Check the current status of order myOrderID_123"

**📊 STATUS AND PROGRESS QUERIES:**
• "Check order status 0x41483bba4be4734faf3cd6810e76d81023318267f7a5210f95141dbe91398245"
• "Order progress for abc123def456"
• "Fill status for order 789xyz012abc"
• "Execution status for order-123-456-789"
• "Show fill percentage for 456789012345"
• "Check if order myOrderID_123 is active"

**🎯 CONTEXT-AWARE QUERIES:**
• "Get details for my Bitcoin prediction order 0x1234567890abcdef"
• "Show election betting order details abc123def456"
• "Details for my sports bet order 789xyz012abc"
• "Check my crypto market order order-123-456-789"
• "Status of weather prediction order 456789012345"

**📋 STRUCTURED QUERIES:**
• "ORDER_DETAILS 0x41483bba4be4734faf3cd6810e76d81023318267f7a5210f95141dbe91398245"
• "Get order { id: abc123def456 }"
• "Details for order = 789xyz012abc"
• "Show order_id: order-123-456-789"
• "Retrieve order(456789012345)"

**🔢 DIFFERENT ORDER ID FORMATS:**
• Hex (64 chars): "Details for 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
• Short alphanumeric: "Status abc123"
• Long alphanumeric: "Details abc123def456789xyz"
• UUID format: "Info 12345678-1234-1234-1234-123456789abc"
• Numeric: "Order 123456789012345"
• Custom format: "Details order-123-456-789"

**📈 WHAT YOU'LL SEE:**
Order details include:
• Order ID and current status
• Market and token information
• Buy/sell side and order type
• Original size vs. matched size
• Price and fill percentage
• Creation and update timestamps
• Fees paid and remaining amounts
• Associated trades and outcomes
• Scoring eligibility status

**💡 Pro Tips:**
• Order IDs are case-sensitive
• Hex IDs usually start with '0x'
• Get order IDs from placement confirmations
• Use GET_ACTIVE_ORDERS to find your order IDs
• Details show both current and historical information`,
          actions: ['GET_ORDER_DETAILS'],
          data: { error: errorMessage },
        };
        if (callback) await callback(errorContent);
        throw new Error(errorMessage);
      }
    }

    if (!orderId) {
      const errorMessage = 'Order ID is missing after extraction attempts.';
      logger.error(`[getOrderDetailsAction] ${errorMessage}`);
      const errorContent: Content = {
        text: `❌ **Error**: ${errorMessage}`,
        actions: ['GET_ORDER_DETAILS'],
        data: { error: errorMessage },
      };
      if (callback) await callback(errorContent);
      throw new Error(errorMessage);
    }

    logger.info(`[getOrderDetailsAction] Attempting to fetch details for Order ID: ${orderId}`);

    try {
      const client = (await initializeClobClientWithCreds(runtime)) as ClobClient;
      const order: any = await client.getOrder(orderId);

      if (!order) {
        logger.warn(`[getOrderDetailsAction] Order not found for ID: ${orderId}`);
        const notFoundContent: Content = {
          text: `🤷 **Order Not Found**: No order exists with the ID \`${orderId}\`.`,
          actions: ['GET_ORDER_DETAILS'],
          data: { error: 'Order not found', orderId, timestamp: new Date().toISOString() },
        };
        if (callback) await callback(notFoundContent);
        return notFoundContent;
      }

      // Use correct field mappings for Polymarket API response
      const orderData = order as PolymarketOrderResponse;

      // Extract fields with proper fallbacks
      const displayOrderId = orderData.id || orderId;
      const marketId = orderData.market || 'Unknown';
      const tokenId = orderData.asset_id || 'Unknown';
      const side = orderData.side || 'Unknown';
      const orderType = orderData.order_type || 'Unknown';
      const status = orderData.status || 'Unknown';
      const price = orderData.price || 'Unknown';
      const originalSize = orderData.original_size || '0';
      const sizeMatched = orderData.size_matched || '0';
      const outcome = orderData.outcome || 'Unknown';
      const expiration = orderData.expiration || 'Unknown';
      const feesInfo = orderData.fees_paid ? `\n  **Fees Paid**: ${orderData.fees_paid}` : '';

      // Handle timestamps properly (Unix timestamps need to be multiplied by 1000)
      const createdAt = orderData.created_at ? new Date(orderData.created_at * 1000) : null;
      const updatedAt = orderData.updated_at ? new Date(orderData.updated_at * 1000) : null;

      // Calculate remaining size and fill percentage
      const remainingSize = parseFloat(originalSize) - parseFloat(sizeMatched);
      const fillPercentage =
        parseFloat(originalSize) > 0
          ? (parseFloat(sizeMatched) / parseFloat(originalSize)) * 100
          : 0;
      const isActive = status === 'LIVE' || status === 'OPEN' || status === 'PARTIAL';

      let responseText = `📦 **Order Details: ${displayOrderId}**\n\n`;
      responseText += `  **Market ID**: ${marketId}\n`;
      responseText += `  **Token/Asset ID**: ${tokenId}\n`;
      responseText += `  **Side**: ${side}, **Type**: ${orderType}\n`;
      responseText += `  **Status**: ${status}\n`;
      responseText += `  **Price**: $${price} (${(parseFloat(price) * 100).toFixed(2)}%)\n`;
      responseText += `  **Original Size**: ${originalSize} shares\n`;
      responseText += `  **Size Matched**: ${sizeMatched} shares\n`;
      responseText += `  **Remaining**: ${remainingSize} shares\n`;
      responseText += `  **Fill Status**: ${fillPercentage.toFixed(1)}% filled\n`;
      responseText += `  **Outcome**: ${outcome}\n`;
      responseText += `  **Expiration**: ${expiration === '0' ? 'Good Till Cancelled (GTC)' : expiration}\n`;
      responseText += feesInfo;

      if (createdAt) {
        responseText += `\n  **Created**: ${createdAt.toLocaleString()}`;
      }
      if (updatedAt) {
        responseText += `\n  **Updated**: ${updatedAt.toLocaleString()}`;
      }

      // Add scoring status
      responseText += `\n\n🎯 **Scoring Status**: ${isActive && remainingSize > 0 ? '✅ Eligible for rewards' : '❌ Not eligible for rewards'}`;

      if (orderData.error_message) {
        responseText += `\n  **Error**: ${orderData.error_message}`;
      }

      // Add trade information
      if (orderData.associate_trades && orderData.associate_trades.length > 0) {
        responseText += `\n  **Associated Trades**: ${orderData.associate_trades.length} trade(s)`;
      } else {
        responseText += `\n  **Associated Trades**: None (order hasn't been matched yet)`;
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['GET_ORDER_DETAILS'],
        data: {
          order: orderData,
          orderId: displayOrderId,
          isActive,
          remainingSize,
          fillPercentage,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error(`[getOrderDetailsAction] Error fetching order ${orderId}:`, error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error fetching order details for ${orderId}**: ${errorMessage}`,
        actions: ['GET_ORDER_DETAILS'],
        data: { error: errorMessage, orderId, timestamp: new Date().toISOString() },
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
          text: 'Get details for order 0x41483bba4be4734faf3cd6810e76d81023318267f7a5210f95141dbe91398245',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching details for order 0x41483bba4be4734faf3cd6810e76d81023318267f7a5210f95141dbe91398245.',
          actions: ['GET_ORDER_DETAILS'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Show me order details for 0x41483bba4be4734faf3cd6810e76d81023318267f7a5210f95141dbe91398245',
        },
      },
      {
        name: '{{user2}}',
        content: { text: "I'll get the order details for you.", actions: ['GET_ORDER_DETAILS'] },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'ORDER_DETAILS 0x41483bba4be4734faf3cd6810e76d81023318267f7a5210f95141dbe91398245',
        },
      },
      {
        name: '{{user2}}',
        content: { text: 'Retrieving order details...', actions: ['GET_ORDER_DETAILS'] },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Check order status 0x41483bba4be4734faf3cd6810e76d81023318267f7a5210f95141dbe91398245',
        },
      },
      {
        name: '{{user2}}',
        content: { text: 'Checking order status...', actions: ['GET_ORDER_DETAILS'] },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Retrieve order 0x41483bba4be4734faf3cd6810e76d81023318267f7a5210f95141dbe91398245',
        },
      },
      {
        name: '{{user2}}',
        content: { text: 'Retrieving order information...', actions: ['GET_ORDER_DETAILS'] },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'order status myOrderID_123' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me get the status for order myOrderID_123.',
          actions: ['GET_ORDER_DETAILS'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'view order 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        },
      },
      {
        name: '{{user2}}',
        content: { text: 'Viewing order details...', actions: ['GET_ORDER_DETAILS'] },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'display order information for 0xabcd1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        },
      },
      {
        name: '{{user2}}',
        content: { text: 'Displaying order information...', actions: ['GET_ORDER_DETAILS'] },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'look up order 0x9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba',
        },
      },
      {
        name: '{{user2}}',
        content: { text: 'Looking up order details...', actions: ['GET_ORDER_DETAILS'] },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'find order 0xdeadbeefcafebabe1234567890abcdef1234567890abcdef1234567890abcdef',
        },
      },
      {
        name: '{{user2}}',
        content: { text: 'Finding order details...', actions: ['GET_ORDER_DETAILS'] },
      },
    ],
  ],
};
