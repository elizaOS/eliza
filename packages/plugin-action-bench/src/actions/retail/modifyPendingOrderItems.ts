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
import { getRetailData } from '../../data/retail/mockData';
import { RetailData, GiftCardPayment, Order } from '../../types/retail';

// Template for extracting item modification parameters
const extractionTemplate = `Extract the item exchange parameters from the user's message and conversation context.

{{recentMessages}}

**Previous Action Results:**
{{actionResults}}

Current user message: "{{userMessage}}"

The function requires these parameters:
- order_id: The order ID with # prefix (e.g., #W0000000)
- item_ids: Comma-separated list of item IDs to modify (e.g., "1008292230,1008292231")
  These are 10-digit item identifiers from the order
- new_item_ids: Comma-separated list of new item IDs to replace with (same count as item_ids)
  These should be variants of the same product
- payment_method_id: Payment method ID for price difference (e.g., gift_card_1234567, credit_card_1234, paypal_1234567)
  This should come from the user's saved payment methods
- current_user_id: The unique internal user ID (if the user is clearly logged in and referenced), otherwise leave it blank.

IMPORTANT:
- The number of item_ids must match the number of new_item_ids
- Items can only be exchanged for variants of the same product
- Look for payment method IDs from previous GET_USER_DETAILS or GET_ORDER_DETAILS results

Respond with ONLY the extracted parameters in this XML format:
<response>
  <order_id>extracted order ID with # prefix</order_id>
  <item_ids>comma-separated item IDs to modify</item_ids>
  <new_item_ids>comma-separated new item IDs</new_item_ids>
  <payment_method_id>payment method ID</payment_method_id>
  <current_user_id>user_abc123</current_user_id>
</response>

If any parameter cannot be found, use empty string for that parameter.`;

export const modifyPendingOrderItems: Action = {
  name: 'MODIFY_PENDING_ORDER_ITEMS',
  similes: ['modify_pending_order_items', 'exchange_items', 'swap_items', 'change_order_items'],
  description: `Modify items in a pending order to exchange them for variants of the same product.
  
  **Required Parameters:**
  - order_id (string): The order ID with '#' prefix (e.g., #W0000000)
  - item_ids (string): Comma-separated list of 10-digit item IDs to exchange (e.g., "1008292230,1008292231")
  - new_item_ids (string): Comma-separated list of new item IDs (same count as item_ids)
  - payment_method_id (string): Payment method for handling price differences (e.g., gift_card_1234567, credit_card_7815826)
  
  **Returns:**
  A JSON object containing the modified order with:
  - order_id: The order identifier
  - user_id: Customer's user ID
  - items: Updated array of items with new item IDs and prices
  - status: "pending (item modified)" to indicate the modification
  - payment_history: Updated payment history including any new charges or refunds
  
  **Action Prerequisites:**
  - User must be authenticated (currentUserId in state)
  - Order must exist and be in "pending" status
  - User must own the order
  - Payment method must exist in user's saved methods
  - For gift cards: sufficient balance for price increases
  
  **Important Limitations:**
  - Can only be called ONCE per pending order
  - Items can only be exchanged for variants of the SAME product
  - Number of items exchanged in must equal items exchanged out
  
  **Security Note:**
  The agent should explain the exchange details (items, price difference) and ask for explicit user confirmation (yes/no) before proceeding.
  
  **Action Chaining:**
  - ALWAYS call GET_ORDER_DETAILS first to get current item_ids
  - May need GET_USER_DETAILS to see available payment methods
  - Use GET_PRODUCT_DETAILS to show exchange options
  
  **When to use:**
  - Customer wants to exchange items for different size/color/variant
  - Customer wants to modify items before order ships
  - Only works for orders with status "pending"
  
  **Do NOT use when:**
  - Order has already been processed, shipped, or delivered
  - Trying to exchange for completely different products
  - Order has already been modified once
  - User not authenticated or doesn't own the order`,
  validate: async (_runtime: IAgentRuntime, _message: Memory, _state?: State) => {
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    // Compose state with RECENT_MESSAGES and ACTION_STATE for context
    state = await runtime.composeState(message, ['RECENT_MESSAGES', 'ACTION_STATE']);

    const retailData: RetailData = state?.values?.retailData || getRetailData();

    // Add userMessage to state values for template
    state.values.userMessage = message.content.text;

    // Use composePromptFromState with our template
    const extractionPrompt = composePromptFromState({
      state,
      template: extractionTemplate,
    });

    try {
      // Use small model for parameter extraction
      const extractionResult = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: extractionPrompt,
      });

      // Parse XML response using parseKeyValueXml
      const parsedParams = parseKeyValueXml(extractionResult);

      const currentUserId = parsedParams?.current_user_id?.trim() || '';

      if (!currentUserId) {
        const errorMsg = `To proceed with modifying the order items, I need to confirm your account. Please provide your email or your name and ZIP code so I can log you in.`;
        if (callback) {
          await callback({
            text: errorMsg,
            source: message.content.source,
          });
        }
        return {
          success: false,
          text: errorMsg,
          error: 'Missing current_user_id',
        };
      }

      const orderId = parsedParams?.order_id?.trim();
      const itemIdsStr = parsedParams?.item_ids?.trim() || '';
      const newItemIdsStr = parsedParams?.new_item_ids?.trim() || '';
      const paymentMethodId = parsedParams?.payment_method_id?.trim();

      if (!orderId || !itemIdsStr || !newItemIdsStr || !paymentMethodId) {
        const errorMsg =
          "I couldn't extract all required parameters. Please specify the order ID, item IDs to modify, new item IDs, and payment method.";
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
      const itemIds = itemIdsStr.split(',').map((id: string) => id.trim());
      const newItemIds = newItemIdsStr.split(',').map((id: string) => id.trim());

      if (itemIds.length !== newItemIds.length) {
        const errorMsg = 'Error: the number of items to be exchanged should match';
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

      // Check if user owns the order
      if (order.user_id !== currentUserId) {
        const errorMsg =
          "You don't have permission to modify this order. You can only modify orders that belong to you.";
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

      // Check if the items to be modified exist
      const allItemIds = order.items.map((item) => item.item_id);
      for (const itemId of itemIds) {
        const countInOrder = allItemIds.filter((id: string) => id === itemId).length;
        const countToModify = itemIds.filter((id: string) => id === itemId).length;
        if (countToModify > countInOrder) {
          const errorMsg = `Error: ${itemId} not found`;
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

      // Check if payment method exists
      const user = retailData.users[order.user_id];
      if (!user?.payment_methods?.[paymentMethodId]) {
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

      const products = retailData.products;
      let diffPrice = 0;

      // Validate new items and calculate price difference
      for (let i = 0; i < itemIds.length; i++) {
        const itemId = itemIds[i];
        const newItemId = newItemIds[i];

        // Find the item in the order
        const item = order.items.find((orderItem) => orderItem.item_id === itemId);
        if (!item) {
          const errorMsg = `Error: ${itemId} not found`;
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

        const productId = item.product_id;
        const product = products[productId];

        // Check if new item exists and is available
        if (!product?.variants?.[newItemId] || !product.variants[newItemId].available) {
          const errorMsg = `Error: new item ${newItemId} not found or available`;
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

        const oldPrice = item.price;
        const newPrice = product.variants[newItemId].price;
        diffPrice += newPrice - oldPrice;
      }

      // Check gift card balance if applicable
      const paymentMethod = user.payment_methods[paymentMethodId];
      if (paymentMethod.source === 'gift_card') {
        const giftCard = paymentMethod as GiftCardPayment;
        const balance = giftCard.balance ?? 0;
        if (balance < diffPrice) {
          const errorMsg = 'Error: insufficient gift card balance to pay for the new item';
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

      // Initialize payment_history if needed
      if (!order.payment_history) {
        order.payment_history = [];
      }

      // Handle the payment or refund
      if (diffPrice !== 0) {
        order.payment_history.push({
          transaction_type: diffPrice > 0 ? 'payment' : 'refund',
          amount: Math.abs(diffPrice),
          payment_method_id: paymentMethodId,
        });

        // Update gift card balance if applicable
        if (paymentMethod.source === 'gift_card') {
          const giftCard = paymentMethod as GiftCardPayment;
          const currentBalance = giftCard.balance ?? 0;
          const newBalance = currentBalance - diffPrice;
          giftCard.balance = Math.round(newBalance * 100) / 100;
        }
      }

      // Modify the order items
      for (let i = 0; i < itemIds.length; i++) {
        const itemId = itemIds[i];
        const newItemId = newItemIds[i];

        const item = order.items.find((orderItem) => orderItem.item_id === itemId);
        if (item) {
          const product = products[item.product_id];
          const newVariant = product.variants[newItemId];

          item.item_id = newItemId;
          item.price = newVariant.price;
          item.options = newVariant.options || {};
        }
      }

      // Update order status to indicate modification
      (order as any).status = 'pending (item modified)';

      // Update the retail data in state
      const updatedRetailData = { ...retailData };
      updatedRetailData.orders[orderId] = order as Order;
      updatedRetailData.users[order.user_id] = user;

      // Return formatted JSON of the modified order
      const responseText = JSON.stringify(order, null, 2);

      if (callback) {
        await callback({
          text: responseText,
          source: message.content.source,
        });
      }

      return {
        success: true,
        text: responseText,
        values: {
          ...state?.values,
          retailData: updatedRetailData,
          lastModifiedOrderId: orderId,
          modificationApplied: true,
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
        content: {
          text: 'Modify item 6469567736 to 6469567737 in order #W2611340 using gift_card_1725971',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: '{"order_id":"#W2611340","user_id":"james_li_5688","items":[{"item_id":"6469567737","product_id":"8310926033","price":52.99}],"status":"pending (item modified)","payment_history":[{"transaction_type":"payment","amount":5.15,"payment_method_id":"gift_card_1725971"}]}',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'Exchange items 1234567890,9876543210 with 1234567891,9876543211 in #W1234567 payment credit_card_7815826',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: '{"order_id":"#W1234567","user_id":"user123","items":[{"item_id":"1234567891"},{"item_id":"9876543211"}],"status":"pending (item modified)"}',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'Swap 8124970213 for 8124970214 in order #W5744371 using paypal_5727330' },
      },
      {
        name: '{{agent}}',
        content: {
          text: '{"order_id":"#W5744371","items":[{"item_id":"8124970214"}],"status":"pending (item modified)","payment_history":[{"transaction_type":"refund","amount":10.00,"payment_method_id":"paypal_5727330"}]}',
        },
      },
    ],
  ] as ActionExample[][],
};
