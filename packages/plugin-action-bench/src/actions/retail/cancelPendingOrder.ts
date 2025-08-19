import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import { ModelType, parseKeyValueXml } from '@elizaos/core';
import { getRetailData } from '../../data/retail/mockData';
import { RetailData, GiftCardPayment } from '../../types/retail';

export const cancelPendingOrder: Action = {
  name: 'CANCEL_PENDING_ORDER',
  description:
    "Cancel a pending order. Only works for orders with status 'pending'. Requires authentication and user confirmation. Refunds are processed immediately for gift cards, otherwise take 5-7 business days.",
  validate: async (_runtime: IAgentRuntime, message: Memory, state?: State) => {
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    // Check authentication
    if (!state?.values?.authenticated || !state?.values?.currentUserId) {
      const errorMsg = "You don't have permission to cancel this order. Please authenticate first.";
      if (callback) {
        await callback({
          text: errorMsg,
          source: message.content.source,
        });
      }
      return {
        success: false,
        text: errorMsg,
        error: errorMsg,
      };
    }

    const retailData: RetailData = state?.values?.retailData || getRetailData();

    // Use LLM to extract parameters with XML format
    const extractionPrompt = `Extract the parameters from the user message for a function that cancels a pending order.

User message: "${message.content.text}"

The function requires these parameters:
- order_id: The order ID with # prefix (e.g., #W0000000)
- reason: Reason for cancellation - must be either "no longer needed" or "ordered by mistake"

Respond with ONLY the extracted parameters in this XML format:
<response>
  <order_id>extracted order ID with # prefix</order_id>
  <reason>extracted cancellation reason</reason>
</response>

If any parameter cannot be found, use empty string for that parameter.`;

    try {
      // Use small model for parameter extraction
      const extractionResult = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: extractionPrompt,
      });

      // Parse XML response using parseKeyValueXml
      const parsedParams = parseKeyValueXml(extractionResult);

      const orderId = parsedParams?.order_id?.trim();
      let reason = parsedParams?.reason?.trim() || 'no longer needed';

      // Validate reason - must be one of the allowed values
      if (reason !== 'no longer needed' && reason !== 'ordered by mistake') {
        reason = 'no longer needed'; // Default to valid reason if invalid
      }

      if (!orderId) {
        const errorMsg =
          "I couldn't find an order ID in your message. Please provide an order ID with the # prefix (e.g., #W0000000).";
        if (callback) {
          await callback({
            text: errorMsg,
            source: message.content.source,
          });
        }
        return {
          success: false,
          text: errorMsg,
          error: errorMsg,
        };
      }

      // Check if order exists
      const order = retailData.orders[orderId];
      if (!order) {
        const errorMsg = `I couldn't find order ${orderId}. Please check the order number and try again.`;
        if (callback) {
          await callback({
            text: errorMsg,
            source: message.content.source,
          });
        }
        return {
          success: false,
          text: errorMsg,
          error: errorMsg,
        };
      }

      // Check if user owns the order
      if (order.user_id !== state.values.currentUserId) {
        const errorMsg =
          "You don't have permission to cancel this order. Please authenticate first.";
        if (callback) {
          await callback({
            text: errorMsg,
            source: message.content.source,
          });
        }
        return {
          success: false,
          text: errorMsg,
          error: errorMsg,
        };
      }

      // Check if order is pending
      if (order.status !== 'pending') {
        const errorMsg = `Order ${orderId} cannot be cancelled as it's already ${order.status}. Only pending orders can be cancelled.`;
        if (callback) {
          await callback({
            text: errorMsg,
            source: message.content.source,
          });
        }
        return {
          success: false,
          text: errorMsg,
          error: errorMsg,
        };
      }

      // Process refunds
      const refunds: Array<{
        transaction_type: string;
        amount: number;
        payment_method_id: string;
      }> = [];

      // Initialize payment_history if it doesn't exist
      if (!order.payment_history) {
        order.payment_history = [
          {
            transaction_type: 'payment',
            amount: order.items.reduce((sum, item) => sum + item.price * (item.quantity || 1), 0),
            payment_method_id: order.payment_method_id || '',
          },
        ];
      }

      // Create refunds for all payments
      for (const payment of order.payment_history) {
        if (payment.transaction_type === 'payment') {
          const refund = {
            transaction_type: 'refund',
            amount: payment.amount,
            payment_method_id: payment.payment_method_id,
          };
          refunds.push(refund);

          // Process gift card refunds immediately
          if (payment.payment_method_id.includes('gift_card')) {
            const user = retailData.users[order.user_id];
            if (user?.payment_methods?.[payment.payment_method_id]) {
              const giftCard = user.payment_methods[payment.payment_method_id] as GiftCardPayment;
              // Initialize balance if undefined (shouldn't happen with proper data)
              if (giftCard.balance === undefined) {
                giftCard.balance = 0;
              }
              giftCard.balance += payment.amount;
              giftCard.balance = Math.round(giftCard.balance * 100) / 100; // Round to 2 decimal places
            }
          }
        }
      }

      // Update order status
      order.status = 'cancelled';
      order.cancel_reason = reason;
      // payment_history was initialized above, but TypeScript doesn't know that
      if (order.payment_history) {
        order.payment_history.push(...refunds);
      }

      // Update the retail data in state
      const updatedRetailData = { ...retailData };
      updatedRetailData.orders[orderId] = order;

      const successMsg = `I've successfully cancelled order ${orderId}. A refund will be processed to your original payment method within 5-7 business days.`;

      if (callback) {
        await callback({
          text: successMsg,
          source: message.content.source,
        });
      }

      return {
        success: true,
        text: successMsg,
        values: {
          ...state?.values,
          retailData: updatedRetailData,
        },
        data: order,
      };
    } catch (error) {
      const errorMsg = `Error during parameter extraction: ${error instanceof Error ? error.message : 'Unknown error'}`;
      if (callback) {
        await callback({
          text: errorMsg,
          source: message.content.source,
        });
      }
      return {
        success: false,
        text: errorMsg,
        error: errorMsg,
      };
    }
  },
  examples: [
    [
      {
        name: '{{user}}',
        content: { text: 'Cancel order #W2611340' },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I've successfully cancelled order #W2611340. A refund will be processed to your original payment method within 5-7 business days.",
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'Please cancel #W1234567 because I found a better price' },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I've successfully cancelled order #W1234567. A refund will be processed to your original payment method within 5-7 business days.",
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'I want to cancel my pending order #W5744371' },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I've successfully cancelled order #W5744371. A refund will be processed to your original payment method within 5-7 business days.",
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'Cancel order #W3847291 - changed my mind' },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I've successfully cancelled order #W3847291. A refund will be processed to your original payment method within 5-7 business days.",
        },
      },
    ],
  ] as ActionExample[][],
};
