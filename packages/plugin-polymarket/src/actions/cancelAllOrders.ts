import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from '@elizaos/core';
import { initializeClobClientWithCreds } from '../utils/clobClient';

// Define the response structure for the callback data property
export interface CancelAllOrdersResponseData {
  success: boolean;
  cancelledOrdersCount: number;
  cancelledOrders: string[];
  message: string;
  timestamp: string;
  error?: string;
}

/**
 * Cancel All Orders Action for Polymarket CLOB
 * Cancels all open orders for the authenticated user
 */
export const cancelAllOrdersAction: Action = {
  name: 'CANCEL_ALL_ORDERS',
  similes: [
    'CANCEL_ALL_ORDERS',
    'CANCEL_ALL',
    'CANCEL_ORDERS',
    'CANCEL_ALL_OPEN_ORDERS',
    'CLOSE_ALL_ORDERS',
    'STOP_ALL_ORDERS',
    'CANCEL_EVERYTHING',
    'CANCEL_ALL_TRADES',
    'CANCEL_ALL_POSITIONS',
    'STOP_ALL_TRADING',
    'CLOSE_ALL_POSITIONS',
    'CANCEL_OPEN_ORDERS',
    'CANCEL_PENDING_ORDERS',
    'CLEAR_ALL_ORDERS',
    'REMOVE_ALL_ORDERS',
  ],
  description:
    'Cancel all open orders for the authenticated user on Polymarket CLOB. This will cancel every pending order across all markets.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info('[cancelAllOrdersAction] Validating action');

    // Check if CLOB API URL is configured
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');
    if (!clobApiUrl) {
      logger.error('[cancelAllOrdersAction] CLOB_API_URL is required in configuration');
      return false;
    }

    // Check if we have API credentials
    const apiKey = runtime.getSetting('CLOB_API_KEY');
    const apiSecret = runtime.getSetting('CLOB_API_SECRET') || runtime.getSetting('CLOB_SECRET');
    const apiPassphrase =
      runtime.getSetting('CLOB_API_PASSPHRASE') || runtime.getSetting('CLOB_PASS_PHRASE');

    if (!apiKey || !apiSecret || !apiPassphrase) {
      logger.error(
        '[cancelAllOrdersAction] Missing required API credentials (CLOB_API_KEY, CLOB_API_SECRET, CLOB_API_PASSPHRASE) in environment.'
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
        '[cancelAllOrdersAction] Missing required private key (POLYMARKET_PRIVATE_KEY, WALLET_PRIVATE_KEY, or PRIVATE_KEY) in environment.'
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
    logger.info('[cancelAllOrdersAction] Handler called!');

    try {
      // Initialize CLOB client with credentials
      const client = await initializeClobClientWithCreds(runtime);

      logger.info('[cancelAllOrdersAction] Cancelling all open orders...');

      // Cancel all open orders using CLOB client
      const cancelResponse = await client.cancelAll();

      logger.info('[cancelAllOrdersAction] Cancel all orders response:', cancelResponse);

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
            ? `Successfully cancelled ${cancelledCount} open orders`
            : 'No open orders found to cancel';
      } else if (cancelResponse && typeof cancelResponse === 'object') {
        // Response is an object with success status
        if (cancelResponse.success !== false) {
          cancelledOrders = cancelResponse.orderIds || cancelResponse.orders || [];
          cancelledCount = cancelledOrders.length;
          responseMessage =
            cancelResponse.message ||
            (cancelledCount > 0
              ? `Successfully cancelled ${cancelledCount} open orders`
              : 'No open orders found to cancel');
        } else {
          throw new Error(
            cancelResponse.error || cancelResponse.message || 'Failed to cancel orders'
          );
        }
      } else {
        // Simple success response
        responseMessage = 'All open orders have been successfully cancelled';
        cancelledCount = 0; // Unknown count
      }

      // Format the response
      const responseData: CancelAllOrdersResponseData = {
        success: true,
        cancelledOrdersCount: cancelledCount,
        cancelledOrders: cancelledOrders,
        message: responseMessage,
        timestamp: new Date().toISOString(),
      };

      // Create success message
      const successMessage = `✅ **All Orders Cancelled Successfully**

**Cancellation Summary:**
• **Orders Cancelled**: ${cancelledCount > 0 ? cancelledCount : 'All open orders'}
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
All your pending orders across all markets have been cancelled. Any partially filled orders will remain as executed, but unfilled portions have been cancelled.`;

      const successContent: Content = {
        text: successMessage,
        actions: ['CANCEL_ALL_ORDERS'],
        data: responseData,
      };

      if (callback) {
        await callback(successContent);
      }
      return successContent;
    } catch (error: any) {
      logger.error('[cancelAllOrdersAction] Error cancelling all orders:', error);

      let errorMessage = 'An unexpected error occurred while cancelling orders.';
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
          errorMessage = 'No open orders found to cancel.';
        } else {
          errorMessage = error.message;
        }
      }

      const errorContent: Content = {
        text: `❌ **Cancel All Orders Failed**

**Error**: ${errorMessage}

**Possible Causes:**
• No open orders to cancel
• Authentication or API credential issues
• Network connectivity problems
• Polymarket API rate limiting
• Orders already cancelled or filled

**What to try:**
• Check if you have any open orders first
• Verify your API credentials are valid
• Check network connection and try again
• Wait a moment and retry if rate limited

**Need Help?**
You can check your active orders first before attempting to cancel them.`,
        actions: ['CANCEL_ALL_ORDERS'],
        data: {
          success: false,
          cancelledOrdersCount: 0,
          cancelledOrders: [],
          message: errorMessage,
          timestamp: new Date().toISOString(),
          error: error.message,
        } as CancelAllOrdersResponseData,
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
          text: 'Cancel all my open orders',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll cancel all your open orders on Polymarket. This will stop all pending orders across all markets.",
          action: 'CANCEL_ALL_ORDERS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Stop all my trading and cancel everything',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll cancel all your open orders immediately. This will stop all pending trades.",
          action: 'CANCEL_ALL_ORDERS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'CANCEL_ALL_ORDERS',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Cancelling all your open orders now. This will clear all pending orders from all markets.',
          action: 'CANCEL_ALL_ORDERS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Kill all my active orders',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll kill all your active orders immediately. This action will cancel every pending order.",
          action: 'CANCEL_ALL_ORDERS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Emergency stop all orders',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Emergency stop activated! Cancelling all your orders across all markets right now.',
          action: 'CANCEL_ALL_ORDERS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Clear all my pending orders',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll clear all your pending orders from all markets. This will cancel every unfilled order.",
          action: 'CANCEL_ALL_ORDERS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Abort all my trades',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Aborting all your trades now. This will cancel all pending orders across your portfolio.',
          action: 'CANCEL_ALL_ORDERS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Remove all my orders from all markets',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll remove all your orders from every market. This comprehensive cancellation will clear your entire order book.",
          action: 'CANCEL_ALL_ORDERS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Terminate all active trading',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Terminating all active trading immediately. Every pending order will be cancelled.',
          action: 'CANCEL_ALL_ORDERS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Cancel everything I have open',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll cancel everything you have open across all prediction markets. This will stop all pending activity.",
          action: 'CANCEL_ALL_ORDERS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Stop all my limit orders',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll stop all your limit orders and any other pending orders. This cancels everything open.",
          action: 'CANCEL_ALL_ORDERS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Revoke all my pending orders',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Revoking all your pending orders now. This will cancel every order waiting for execution.',
          action: 'CANCEL_ALL_ORDERS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Withdraw all orders',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll withdraw all your orders from all markets. This action will cancel your entire order portfolio.",
          action: 'CANCEL_ALL_ORDERS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'DELETE ALL ORDERS',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Deleting all orders as requested. This will cancel every pending order in your account.',
          action: 'CANCEL_ALL_ORDERS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Close all my open positions',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll close all your open positions by cancelling all pending orders. Note: This only cancels unfilled orders, not executed positions.",
          action: 'CANCEL_ALL_ORDERS',
        },
      },
    ],
  ],
};
