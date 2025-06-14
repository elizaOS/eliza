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

// Define the payload for extracting order ID
export interface CancelOrderPayload {
  orderId: string;
  error?: string;
}

// Define the response structure for the callback data property
export interface CancelOrderResponseData {
  success: boolean;
  orderId: string;
  message: string;
  timestamp: string;
  error?: string;
}

/**
 * Cancel Order by ID Action for Polymarket CLOB
 * Cancels a specific order by its ID
 */
export const cancelOrderByIdAction: Action = {
  name: 'CANCEL_ORDER',
  similes: [
    'CANCEL_ORDER',
    'CANCEL_ORDER_BY_ID',
    'CANCEL_SPECIFIC_ORDER',
    'CANCEL_ORDER_ID',
    'STOP_ORDER',
    'REMOVE_ORDER',
    'DELETE_ORDER',
    'CANCEL_TRADE',
    'STOP_TRADE',
    'CLOSE_ORDER',
    'ABORT_ORDER',
    'REVOKE_ORDER',
    'WITHDRAW_ORDER',
    'KILL_ORDER',
    'TERMINATE_ORDER',
  ],
  description:
    'Cancel a specific order by its ID on Polymarket CLOB. Requires the exact order ID to cancel the order.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info('[cancelOrderByIdAction] Validating action');

    // First check if this message is actually about canceling an order
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
    ];
    const containsCancelKeyword = cancelKeywords.some((keyword) => messageText.includes(keyword));

    if (!containsCancelKeyword) {
      logger.info(
        '[cancelOrderByIdAction] Message does not contain cancel keywords, rejecting validation'
      );
      return false;
    }

    // Check if CLOB API URL is configured
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');
    if (!clobApiUrl) {
      logger.error('[cancelOrderByIdAction] CLOB_API_URL is required in configuration');
      return false;
    }

    // Check if we have API credentials
    const apiKey = runtime.getSetting('CLOB_API_KEY');
    const apiSecret = runtime.getSetting('CLOB_API_SECRET') || runtime.getSetting('CLOB_SECRET');
    const apiPassphrase =
      runtime.getSetting('CLOB_API_PASSPHRASE') || runtime.getSetting('CLOB_PASS_PHRASE');

    if (!apiKey || !apiSecret || !apiPassphrase) {
      logger.error(
        '[cancelOrderByIdAction] Missing required API credentials (CLOB_API_KEY, CLOB_API_SECRET, CLOB_API_PASSPHRASE) in environment.'
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
        '[cancelOrderByIdAction] Missing required private key (POLYMARKET_PRIVATE_KEY, WALLET_PRIVATE_KEY, or PRIVATE_KEY) in environment.'
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
    logger.info('[cancelOrderByIdAction] Handler called!');

    try {
      // Extract order ID from user message using LLM
      const extractionPrompt = `
Extract the order ID from this message about canceling a specific order:
"${message.content.text}"

Extract and return a JSON object with the following field:
- orderId: string (the order ID to cancel)

Examples:
- "Cancel order abc123def456" → {"orderId": "abc123def456"}
- "Stop order ID 789xyz012abc" → {"orderId": "789xyz012abc"}
- "CANCEL_ORDER order-123-456-789" → {"orderId": "order-123-456-789"}
- "Remove the order with ID 0x1234567890abcdef" → {"orderId": "0x1234567890abcdef"}

If no order ID is found or "NONE", return {"error": "Missing order ID"}.
Return only the JSON object, no additional text.
`;

      logger.info('[cancelOrderByIdAction] Starting LLM parameter extraction...');

      const extractedParams = await callLLMWithTimeout(
        runtime,
        state,
        extractionPrompt,
        'cancelOrderByIdAction',
        10000
      );

      logger.debug(`[cancelOrderByIdAction] Parsed LLM parameters:`, extractedParams);

      // Handle both string and object responses from LLM
      let orderParams: CancelOrderPayload;
      if (typeof extractedParams === 'string') {
        try {
          orderParams = JSON.parse(extractedParams);
        } catch (parseError) {
          throw new Error(`Failed to parse LLM response as JSON: ${extractedParams}`);
        }
      } else if (typeof extractedParams === 'object' && extractedParams !== null) {
        orderParams = extractedParams as CancelOrderPayload;
      } else {
        throw new Error('Invalid response from LLM parameter extraction');
      }

      // Validate extracted parameters
      if (!orderParams || orderParams.error || !orderParams.orderId) {
        // Try regex fallback for structured input
        const regexPattern =
          /(?:cancel|stop|remove|delete)\s+(?:order\s+)?(?:id\s+|with\s+id\s+)?(0x[a-fA-F0-9]+|[a-zA-Z0-9\-_]{8,})/i;
        const regexMatch = message.content.text.match(regexPattern);

        if (regexMatch) {
          orderParams = {
            orderId: regexMatch[1],
          };
        } else {
          // Try to extract just the hex order ID from the message
          const hexPattern = /(0x[a-fA-F0-9]{64})/;
          const hexMatch = message.content.text.match(hexPattern);

          if (hexMatch) {
            orderParams = {
              orderId: hexMatch[1],
            };
          } else {
            const errorMessage = `❌ **Order Cancellation Failed**

**Error**: Please provide a valid order ID to cancel

**🛑 BASIC CANCEL EXAMPLES:**
• "Cancel order abc123def456"
• "Stop order ID 789xyz012abc"
• "Remove the order with ID order-123-456-789"
• "Delete order 0x1234567890abcdef"
• "CANCEL_ORDER 456789012345"
• "Abort order #987654321098"

**⚡ QUICK CANCEL FORMATS:**
• "Cancel abc123"
• "Stop 789xyz"
• "Remove order-123"
• "Delete 0x1234"
• "Kill 456789"
• "Terminate order xyz789"

**🔍 DETAILED CANCEL REQUESTS:**
• "Cancel my buy order with ID abc123def456"
• "Stop the sell order ID 789xyz012abc from executing"
• "Remove the limit order with ID order-123-456-789"
• "Delete the market order 0x1234567890abcdef"
• "Abort the GTC order with ID 456789012345"
• "Revoke my order #987654321098 immediately"

**📋 STRUCTURED CANCEL COMMANDS:**
• "CANCEL_ORDER orderId: abc123def456"
• "Cancel order { id: 789xyz012abc }"
• "Stop order [order-123-456-789]"
• "Remove order = 0x1234567890abcdef"
• "Delete order_id 456789012345"

**🎯 CONTEXT-AWARE CANCELLATIONS:**
• "Cancel my Bitcoin bet order abc123def456"
• "Stop the election prediction order 789xyz012abc"
• "Remove my sports betting order order-123-456-789"
• "Delete the weather prediction order 0x1234567890abcdef"

**⚠️ URGENT CANCELLATIONS:**
• "URGENT: Cancel order abc123def456 now!"
• "Emergency stop order 789xyz012abc"
• "Immediately cancel order-123-456-789"
• "Quick cancel 0x1234567890abcdef"
• "Rush cancel order 456789012345"

**🔢 DIFFERENT ORDER ID FORMATS:**
• Short IDs: "Cancel order abc123"
• Long IDs: "Cancel order abc123def456789xyz"
• Hex IDs: "Cancel 0x1234567890abcdef1234567890abcdef12345678"
• UUID format: "Cancel 12345678-1234-1234-1234-123456789abc"
• Numeric: "Cancel order 123456789012345"

**Required Parameter**:
• **Order ID**: The specific order identifier to cancel

**💡 How to find Order IDs:**
You can get order IDs from:
• Order placement responses ("Order placed with ID: abc123")
• Active orders list (GET_ACTIVE_ORDERS)
• Order history queries (GET_ORDER_DETAILS)
• Trade confirmations and receipts
• Wallet transaction history

**🚨 Important Notes:**
• Order cancellation is immediate and irreversible
• Only your own orders can be cancelled
• Already executed orders cannot be cancelled
• Partially filled orders will cancel the remaining amount`;

            const errorContent: Content = {
              text: errorMessage,
              actions: ['CANCEL_ORDER'],
              data: {
                success: false,
                orderId: '',
                message: 'Missing order ID',
                timestamp: new Date().toISOString(),
                error: 'Missing order ID',
              } as CancelOrderResponseData,
            };

            if (callback) {
              await callback(errorContent);
            }
            return errorContent;
          }
        }
      }

      // Validate order ID format
      if (!orderParams.orderId || orderParams.orderId.length < 8) {
        throw new Error('Order ID must be at least 8 characters long');
      }

      logger.info(`[cancelOrderByIdAction] Canceling order ID: ${orderParams.orderId}`);

      // Initialize CLOB client with credentials
      const client = await initializeClobClientWithCreds(runtime);

      logger.info('[cancelOrderByIdAction] Cancelling order...');

      // Cancel the specific order using CLOB client
      const cancelResponse = await client.cancelOrder({ orderID: orderParams.orderId });

      logger.info('[cancelOrderByIdAction] Cancel order response:', cancelResponse);

      // Handle the response
      let responseMessage = '';
      let success = true;

      if (cancelResponse && typeof cancelResponse === 'object') {
        // Response is an object with success status
        if (cancelResponse.success !== false) {
          responseMessage =
            cancelResponse.message ||
            `Order ${orderParams.orderId} has been successfully cancelled`;
        } else {
          throw new Error(
            cancelResponse.error || cancelResponse.message || 'Failed to cancel order'
          );
        }
      } else if (cancelResponse === true || cancelResponse === 'success') {
        // Simple success response
        responseMessage = `Order ${orderParams.orderId} has been successfully cancelled`;
      } else {
        // Assume success if we got any non-error response
        responseMessage = `Order ${orderParams.orderId} has been successfully cancelled`;
      }

      // Format the response
      const responseData: CancelOrderResponseData = {
        success: true,
        orderId: orderParams.orderId,
        message: responseMessage,
        timestamp: new Date().toISOString(),
      };

      // Create success message
      const successMessage = `✅ **Order Cancelled Successfully**

**Cancellation Details:**
• **Order ID**: \`${orderParams.orderId}\`
• **Status**: Cancelled
• **Timestamp**: ${responseData.timestamp}

**Result**: ${responseMessage}

**⚠️ Important Note:**
The order has been permanently cancelled and cannot be restored. Any unfilled portions of the order will no longer execute, but any already executed portions remain valid.`;

      const successContent: Content = {
        text: successMessage,
        actions: ['CANCEL_ORDER'],
        data: responseData,
      };

      if (callback) {
        await callback(successContent);
      }
      return successContent;
    } catch (error: any) {
      logger.error('[cancelOrderByIdAction] Error cancelling order:', error);

      let errorMessage = 'An unexpected error occurred while cancelling the order.';
      if (error.message) {
        if (error.message.includes('not found') || error.message.includes('does not exist')) {
          errorMessage = 'Order not found. The order may have already been cancelled or filled.';
        } else if (
          error.message.includes('unauthorized') ||
          error.message.includes('authentication')
        ) {
          errorMessage = 'Authentication failed. Please check your API credentials.';
        } else if (error.message.includes('network') || error.message.includes('connection')) {
          errorMessage = 'Network connectivity issues. Please try again in a moment.';
        } else if (error.message.includes('rate limit')) {
          errorMessage = 'Rate limit exceeded. Please wait before trying again.';
        } else if (
          error.message.includes('already cancelled') ||
          error.message.includes('already filled')
        ) {
          errorMessage =
            'Order cannot be cancelled because it is already cancelled or fully filled.';
        } else if (error.message.includes('invalid') || error.message.includes('Order ID')) {
          errorMessage = 'Invalid order ID format. Please provide a valid order identifier.';
        } else {
          errorMessage = error.message;
        }
      }

      const errorContent: Content = {
        text: `❌ **Order Cancellation Failed**

**Error**: ${errorMessage}

**Possible Causes:**
• Order does not exist or has been removed
• Order has already been cancelled or fully filled
• Invalid order ID format
• Authentication or API credential issues
• Network connectivity problems
• Polymarket API rate limiting

**What to try:**
• Verify the order ID is correct and complete
• Check if the order still exists and is active
• Ensure your API credentials are valid
• Check network connection and try again
• Wait a moment and retry if rate limited

**How to find valid Order IDs:**
• Check recent order placement responses
• Use the active orders action to list current orders
• Review order history for previously placed orders`,
        actions: ['CANCEL_ORDER'],
        data: {
          success: false,
          orderId: '',
          message: errorMessage,
          timestamp: new Date().toISOString(),
          error: error.message,
        } as CancelOrderResponseData,
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
          text: 'Cancel order abc123def456',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll cancel the order with ID abc123def456 for you.",
          action: 'CANCEL_ORDER',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Stop order ID 789xyz012abc',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll stop the order 789xyz012abc immediately.",
          action: 'CANCEL_ORDER',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Remove the order with ID order-123-456-789',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll remove the order order-123-456-789 from the order book.",
          action: 'CANCEL_ORDER',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Cancel the order with ID 0xa1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll cancel the order with ID 0xa1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456.",
          action: 'CANCEL_ORDER',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'CANCEL_ORDER 0x1234567890abcdef1234567890abcdef12345678',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Cancelling order 0x1234567890abcdef1234567890abcdef12345678 now.',
          action: 'CANCEL_ORDER',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Delete order trade-abc-123',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll delete the order trade-abc-123.",
          action: 'CANCEL_ORDER',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Kill the order with id market_order_567',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll kill the order market_order_567 immediately.",
          action: 'CANCEL_ORDER',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Abort order execution for order ID limit_buy_999',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Aborting order execution for limit_buy_999.',
          action: 'CANCEL_ORDER',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Terminate my order FOK_12345678',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll terminate your order FOK_12345678.",
          action: 'CANCEL_ORDER',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Withdraw order request gtc_order_2024',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Withdrawing order request gtc_order_2024.',
          action: 'CANCEL_ORDER',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Revoke the order with identifier poly_trade_888',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll revoke the order poly_trade_888.",
          action: 'CANCEL_ORDER',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Close my pending order limit_sell_777',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll close your pending order limit_sell_777.",
          action: 'CANCEL_ORDER',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Stop trade execution for order user_order_456789',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Stopping trade execution for order user_order_456789.',
          action: 'CANCEL_ORDER',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Remove order from queue: queue_order_2024_01',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Removing order queue_order_2024_01 from the queue.',
          action: 'CANCEL_ORDER',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Please cancel my order with the ID conditional_987654',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll cancel your order conditional_987654.",
          action: 'CANCEL_ORDER',
        },
      },
    ],
  ],
};
