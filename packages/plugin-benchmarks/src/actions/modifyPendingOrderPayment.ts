import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import { ModelType, parseKeyValueXml, composePromptFromState } from '@elizaos/core';
import { getRetailData } from '../data/retail/mockData';
import { RetailData, GiftCardPayment, Order } from '../types/retail';

export const modifyPendingOrderPayment: Action = {
  name: 'MODIFY_PENDING_ORDER_PAYMENT',
  description:
    'Modify the payment method of a pending order. The agent needs to explain the modification detail and ask for explicit user confirmation (yes/no) to proceed.',
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
    // Compose state to get conversation context
    state = await runtime.composeState(message, ['RECENT_MESSAGES']);

    // Get room-specific data for isolation in parallel tests
    const roomId = message.roomId;
    const retailData: RetailData = getRetailData(roomId);

    // Use LLM to extract parameters with XML format
    const extractionPrompt = `Extract the parameters from the conversation for changing the payment method of a pending order.

{{recentMessages}}

Current user message: "${message.content.text}"

The function requires these parameters:
- order_id: The order ID with # prefix (e.g., #W0000000)
- payment_method_id: New payment method ID (e.g., credit_card_1234, paypal_5678, gift_card_1234567)
- is_authenticated: Check if the user has been authenticated in the conversation (look for "successfully authenticated" or "authentication completed")

Respond with ONLY the extracted parameters in this XML format:
<response>
  <order_id>extracted order ID with # prefix</order_id>
  <payment_method_id>extracted payment method ID</payment_method_id>
  <is_authenticated>yes or no</is_authenticated>
</response>

If any parameter cannot be found, use empty string for that parameter.`;

    try {
      // Compose prompt with state values
      const prompt = composePromptFromState({
        state,
        template: extractionPrompt,
      });

      // Use small model for parameter extraction
      const extractionResult = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      // Parse XML response using parseKeyValueXml
      const parsedParams = parseKeyValueXml(extractionResult);

      const isAuthenticated = parsedParams?.is_authenticated?.toLowerCase() === 'yes';

      if (!isAuthenticated) {
        const errorMsg = `To proceed with modifying the order payment method, I need to verify your identity first. Please provide your email address or your name and ZIP code for authentication.`;
        if (callback) {
          await callback({
            text: errorMsg,
            source: message.content.source,
          });
        }
        return {
          success: false,
          text: errorMsg,
          error: 'User not authenticated',
        };
      }

      const orderId = parsedParams?.order_id?.trim();
      const paymentMethodId = parsedParams?.payment_method_id?.trim();

      if (!orderId || !paymentMethodId) {
        const errorMsg =
          "I couldn't extract all required parameters. Please specify the order ID and the new payment method ID.";
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
      const order = retailData.orders[orderId] as Order;
      if (!order) {
        const errorMsg = `Error: order not found`;
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

      // Since user is authenticated, we proceed with payment modification
      // In a real system, we'd verify ownership through session/token

      // Check if order is pending
      if (order.status !== 'pending') {
        const errorMsg = `Error: non-pending order cannot be modified`;
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

      // Check if payment method exists and belongs to the user
      const user = retailData.users[order.user_id];
      if (!user?.payment_methods?.[paymentMethodId]) {
        const errorMsg = `Error: payment method not found`;
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

      // Initialize payment_history if needed
      if (!order.payment_history) {
        const totalAmount = order.items.reduce((sum, item) => sum + item.price, 0);
        order.payment_history = [
          {
            transaction_type: 'payment',
            amount: totalAmount,
            payment_method_id: order.payment_method_id || paymentMethodId,
          },
        ];
      }

      // Check that there's exactly one payment
      const payments = order.payment_history.filter((p) => p.transaction_type === 'payment');
      if (
        payments.length > 1 ||
        (payments.length === 1 && payments[0].transaction_type !== 'payment')
      ) {
        const errorMsg = 'Error: there should be exactly one payment for a pending order';
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

      const currentPayment = payments[0];

      // Check if new payment method is different
      if (currentPayment.payment_method_id === paymentMethodId) {
        const errorMsg = `Error: the new payment method should be different from the current one`;
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

      const orderTotal = currentPayment.amount;
      const newPaymentMethod = user.payment_methods[paymentMethodId];

      // Check gift card balance if applicable
      if (newPaymentMethod.source === 'gift_card') {
        const giftCard = newPaymentMethod as GiftCardPayment;
        const balance = giftCard.balance ?? 0;
        if (balance < orderTotal) {
          const errorMsg = `Error: insufficient gift card balance to pay for the order`;
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
      }

      // Create new payment transaction
      const newPayment = {
        transaction_type: 'payment',
        amount: orderTotal,
        payment_method_id: paymentMethodId,
      };

      // Create refund for old payment
      const refund = {
        transaction_type: 'refund',
        amount: orderTotal,
        payment_method_id: currentPayment.payment_method_id,
      };

      // Update payment history
      order.payment_history.push(newPayment);
      order.payment_history.push(refund);

      // Handle gift card transactions
      // Process new payment
      if (newPaymentMethod.source === 'gift_card') {
        const giftCard = newPaymentMethod as GiftCardPayment;
        const currentBalance = giftCard.balance ?? 0;
        giftCard.balance = Math.round((currentBalance - orderTotal) * 100) / 100;
      }

      // Process refund to old payment method
      const oldPaymentMethod = user.payment_methods[currentPayment.payment_method_id];
      if (oldPaymentMethod?.source === 'gift_card') {
        const giftCard = oldPaymentMethod as GiftCardPayment;
        const currentBalance = giftCard.balance ?? 0;
        giftCard.balance = Math.round((currentBalance + orderTotal) * 100) / 100;
      }

      // Update order payment method (not actually set in the Python code but implied)
      // order.payment_method_id = paymentMethodId; // Python doesn't update this

      // Return JSON of the order like Python implementation
      const successMsg = JSON.stringify(order);

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
          lastModifiedOrderId: orderId,
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
};
