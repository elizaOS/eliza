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
import { RetailData } from '../types/retail';

export const returnDeliveredOrderItems: Action = {
  name: 'RETURN_DELIVERED_ORDER_ITEMS',
  description:
    "Return some items of a delivered order. The order status will be changed to 'return requested'. The agent needs to explain the return detail and ask for explicit user confirmation (yes/no) to proceed. The user will receive follow-up email for how and where to return the item.",
  validate: async (_runtime: IAgentRuntime, message: Memory, state?: State) => {
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    // Compose state to get conversation context
    state = await runtime.composeState(message, ['RECENT_MESSAGES']);

    // Get room-specific data for isolation in parallel tests
    const roomId = message.roomId;
    const retailData: RetailData = getRetailData(roomId);

    // Use LLM to extract parameters
    const extractionPrompt = `Extract parameters from the conversation for processing a return of delivered order items.

{{recentMessages}}

Current user message: "${message.content.text}"

The function requires:
- order_id: Order ID with # prefix (e.g., "#W1234567")
- item_ids: Comma-separated list of 10-digit item IDs to return
- payment_method_id: Payment method ID to receive refund (e.g., gift_card_0000000 or credit_card_0000000)
- is_authenticated: Check if the user has been authenticated in the conversation (look for "successfully authenticated" or "authentication completed")

Respond with ONLY the extracted parameters in this XML format:
<response>
  <order_id>extracted order id with #</order_id>
  <item_ids>comma-separated item ids</item_ids>
  <payment_method_id>payment method id</payment_method_id>
  <is_authenticated>yes or no</is_authenticated>
</response>

If a parameter cannot be found, use empty string for that parameter.`;

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

      // Parse XML response
      const parsedParams = parseKeyValueXml(extractionResult);

      const isAuthenticated = parsedParams?.is_authenticated?.toLowerCase() === 'yes';

      if (!isAuthenticated) {
        const errorMsg = `To proceed with returning items, I need to verify your identity first. Please provide your email address or your name and ZIP code for authentication.`;
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

      const orderId = parsedParams?.order_id?.trim() || '';
      const itemIdsStr = parsedParams?.item_ids?.trim() || '';
      const paymentMethodId = parsedParams?.payment_method_id?.trim() || '';

      if (!orderId || !itemIdsStr || !paymentMethodId) {
        const errorMsg = 'Please specify the order ID, item IDs to return, and payment method ID.';
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

      // Find the order
      const order = retailData.orders[orderId];
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

      // Since user is authenticated, we proceed with return
      // In a real system, we'd verify ownership through session/token

      // Check order status
      if (order.status !== 'delivered') {
        const errorMsg = `Error: non-delivered order cannot be returned`;
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

      // Get user profile to validate payment method
      const userProfile = retailData.users[order.user_id];

      // Check if payment method exists
      if (!userProfile?.payment_methods?.[paymentMethodId]) {
        const errorMsg = 'Error: payment method not found';
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

      // Check if payment method is either the original or a gift card
      const originalPaymentMethodId =
        order.payment_history?.[0]?.payment_method_id || order.payment_method_id;
      if (!paymentMethodId.includes('gift_card') && paymentMethodId !== originalPaymentMethodId) {
        const errorMsg =
          'Error: payment method should be either the original payment method or a gift card';
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

      // Parse item IDs
      const itemIdsToReturn = itemIdsStr.split(',').map((id: string) => id.trim());

      if (itemIdsToReturn.length === 0 || itemIdsToReturn[0] === '') {
        const errorMsg = 'Please specify which items you want to return.';
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

      // Check if the items to be returned exist (there could be duplicate items)
      const allItemIds = order.items.map((item) => item.item_id);
      for (const itemId of itemIdsToReturn) {
        const countInOrder = allItemIds.filter((id: string) => id === itemId).length;
        const countToReturn = itemIdsToReturn.filter((id: string) => id === itemId).length;
        if (countToReturn > countInOrder) {
          const errorMsg = 'Error: some item not found';
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

      // Update order with return information directly in the mutable data
      (order as any).status = 'return requested';
      (order as any).return_items = itemIdsToReturn.sort();
      (order as any).return_payment_method_id = paymentMethodId;

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
          orderId,
          itemIdsToReturn,
          paymentMethodId,
        },
        data: order,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      const errorText = `Error processing return: ${errorMessage}`;

      if (callback) {
        await callback({
          text: errorText,
          source: message.content.source,
        });
      }

      return {
        success: false,
        text: errorText,
        error: errorMessage,
      };
    }
  },
};
