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
import { RetailData, OrderItem, GiftCardPayment } from '../../types/retail';
import { composePromptFromState } from '@elizaos/core';

export const exchangeDeliveredOrderItems: Action = {
  name: 'EXCHANGE_DELIVERED_ORDER_ITEMS',
  description:
    'Exchange delivered items for different variants. User must specify the order ID and items to exchange (old item_id -> new item_id mappings). Exchange items in a delivered order to new items of the same product type. For a delivered order, return or exchange can only be done once by the agent. The agent must explain the exchange details and explicitly ask the user for confirmation (yes/no) before proceeding. This action should only be selected if product information (availability, item IDs, etc.) has already been verified.',
  validate: async (_runtime: IAgentRuntime, message: Memory, state?: State) => {
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback,
    responses?: Memory[]
  ): Promise<ActionResult> => {
    const thoughtSnippets =
      responses
        ?.map((res) => res.content?.thought)
        .filter(Boolean)
        .join('\n') ?? '';
    const retailData: RetailData = state?.values?.retailData || getRetailData();

    // Use LLM to extract parameters
    const extractionPrompt = `Extract parameters from the conversation (and the agent's internal thought) for exchanging delivered order items.

Conversation:
{{recentMessages}}

Agent Thought (why this step was chosen):
${thoughtSnippets}

Your task is to extract:
- order_id: The order ID with # prefix (e.g., "#W1234567" or "#M7654321")
- exchanges: List of item exchanges in the format "old_item_id:new_item_id", separated by commas
- current_user_id: The unique internal user ID (if the user is clearly logged in and referenced), otherwise leave it blank.

Response format (XML):
<response>
  <order_id>#orderId</order_id>
  <exchanges>old1:new1,old2:new2</exchanges>
  <current_user_id>user_abc123</current_user_id>
</response>

If a value is not found, return an empty string for that element. Do not add any commentary or explanation.`;

    try {
      const prompt = composePromptFromState({
        state: state || { values: {}, data: {}, text: '' },
        template: extractionPrompt,
      });

      const extractionResult = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
      });

      // Parse XML response
      const parsedParams = parseKeyValueXml(extractionResult);
      const currentUserId = parsedParams?.current_user_id?.trim() || '';

      if (!currentUserId) {
        const errorMsg = `To proceed with the exchange, I need to confirm your account. Please provide your email or your name and ZIP code so I can log you in.`;
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
      const orderId = parsedParams?.order_id?.trim() || '';
      const exchangesStr = parsedParams?.exchanges?.trim() || '';

      if (!orderId || !orderId.match(/^#[WM]\d{7}$/)) {
        const errorMsg =
          'Please specify a valid order ID with # prefix (e.g., #W1234567 or #M7654321).';
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

      // Parse exchanges into mapping
      const exchangeMapping: { [oldItemId: string]: string } = {};
      if (exchangesStr) {
        const exchangePairs = exchangesStr.split(',').map((pair: string) => pair.trim());
        for (const pair of exchangePairs) {
          const [oldId, newId] = pair.split(':').map((id: string) => id.trim());
          if (oldId && newId && oldId.length === 10 && newId.length === 10) {
            exchangeMapping[oldId] = newId;
          }
        }
      }

      if (Object.keys(exchangeMapping).length === 0) {
        const errorMsg =
          'Cannot process exchange: Please specify which items to exchange (e.g., "exchange item 1234567890 for 0987654321").';
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

      console.log('############### order', order);

      if (!order) {
        const errorMsg = `Cannot process exchange: Order ${orderId} not found.`;
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

      // Verify order belongs to current user
      if (order.user_id !== currentUserId) {
        const errorMsg =
          'Cannot process exchange: You can only exchange items from your own orders.';
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

      // Check order status
      if (order.status !== 'delivered') {
        const errorMsg = `Cannot process exchange: Order ${orderId} hasn't been delivered yet. Current status: ${order.status}.`;
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

      // Validate old items exist in order
      const orderItemIds = order.items.map((item) => item.item_id);
      const invalidOldItems = Object.keys(exchangeMapping).filter(
        (itemId) => !orderItemIds.includes(itemId)
      );

      if (invalidOldItems.length > 0) {
        const errorMsg = `Cannot process exchange: The following items are not in order ${orderId}: ${invalidOldItems.join(', ')}`;
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

      // Validate new items and check they are variants of the same products
      const validationErrors: string[] = [];
      const priceDifferences: number[] = [];

      for (const [oldItemId, newItemId] of Object.entries(exchangeMapping)) {
        // Find the old item and its product
        const oldItem = order.items.find((item) => item.item_id === oldItemId)!;
        const oldProduct = retailData.products[oldItem.product_id];

        if (!oldProduct) {
          validationErrors.push(`Product not found for item ${oldItemId}`);
          continue;
        }

        // Check if new item is a variant of the same product
        const newVariant = oldProduct.variants[newItemId];
        if (!newVariant) {
          // Check if it's a variant of a different product (not allowed)
          let found = false;
          for (const product of Object.values(retailData.products)) {
            if (product.variants[newItemId]) {
              validationErrors.push(
                `Item ${newItemId} is not a variant of the same product as ${oldItemId}`
              );
              found = true;
              break;
            }
          }
          if (!found) {
            validationErrors.push(`Item ${newItemId} not found in any product catalog`);
          }
          continue;
        }

        // Check availability
        if (!newVariant.available) {
          validationErrors.push(`Item ${newItemId} is not available`);
          continue;
        }

        // Calculate price difference
        const priceDiff = newVariant.price - oldItem.price;
        priceDifferences.push(priceDiff);
      }

      if (validationErrors.length > 0) {
        const errorMsg = `Cannot process exchange: ${validationErrors.join('; ')}`;
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

      // Calculate total price difference
      const totalPriceDiff = priceDifferences.reduce((sum, diff) => sum + diff, 0);

      // Get user profile and payment method
      const userProfile = retailData.users[currentUserId];
      const payment = order?.payment_history?.find((p) => p.transaction_type === 'payment');

      const paymentMethodId = payment?.payment_method_id;

      if (!paymentMethodId) {
        const errorMsg =
          'Cannot process exchange: No payment method found for this order. Please contact customer support.';
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

      const paymentMethod = userProfile.payment_methods[paymentMethodId];

      if (!paymentMethod) {
        const errorMsg =
          'Cannot process exchange: Original payment method not found. Please contact customer support.';
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

      // For gift cards, validate sufficient balance if price difference is positive
      if (paymentMethod.source === 'gift_card' && totalPriceDiff > 0) {
        const giftCard = paymentMethod as GiftCardPayment;
        const currentBalance = giftCard.balance ?? 0; // Default to 0 if undefined
        if (currentBalance < totalPriceDiff) {
          const errorMsg = `Cannot process exchange: Insufficient gift card balance. Price difference is $${totalPriceDiff.toFixed(2)} but gift card has only $${currentBalance.toFixed(2)}.`;
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

      // Create deep copy of retail data for updates
      const updatedRetailData = JSON.parse(JSON.stringify(retailData));
      const updatedOrder = updatedRetailData.orders[orderId];

      // Update order items with exchanged variants
      const exchangedItems: string[] = [];
      for (const [oldItemId, newItemId] of Object.entries(exchangeMapping)) {
        const oldItemIndex = updatedOrder.items.findIndex(
          (item: OrderItem) => item.item_id === oldItemId
        );
        const oldItem = order.items.find((item) => item.item_id === oldItemId)!;
        const product = retailData.products[oldItem.product_id];
        const newVariant = product.variants[newItemId];

        // Replace the item with new variant
        updatedOrder.items[oldItemIndex] = {
          name: product.name,
          product_id: oldItem.product_id,
          item_id: newItemId,
          price: newVariant.price,
          options: newVariant.options,
        };

        exchangedItems.push(`${oldItemId} → ${newItemId}`);
      }

      // Update order status and metadata to match Python implementation
      updatedOrder.status = 'exchange requested';
      // Sort the arrays independently to match Python's sorted() behavior
      updatedOrder.exchange_items = Object.keys(exchangeMapping).sort();
      updatedOrder.exchange_new_items = Object.values(exchangeMapping).sort();
      updatedOrder.exchange_payment_method_id = paymentMethodId;
      updatedOrder.exchange_price_difference = totalPriceDiff;

      // Update gift card balance if applicable
      if (paymentMethod.source === 'gift_card' && totalPriceDiff > 0) {
        const updatedUser = updatedRetailData.users[currentUserId];
        // We know paymentMethodId is defined here because we checked it earlier
        const updatedGiftCard = updatedUser.payment_methods[paymentMethodId!] as GiftCardPayment;
        // Initialize balance if undefined (shouldn't happen with proper data)
        if (updatedGiftCard.balance === undefined) {
          updatedGiftCard.balance = 0;
        }
        updatedGiftCard.balance -= totalPriceDiff;
      }

      // Prepare detailed exchange summary
      const itemSummaries: string[] = [];
      let index = 0;

      for (const [oldItemId, newItemId] of Object.entries(exchangeMapping)) {
        const oldItem = order.items.find((item) => item.item_id === oldItemId)!;
        const product = retailData.products[oldItem.product_id];
        const newVariant = product.variants[newItemId];
        const priceDiff = priceDifferences[index++];

        // Format options from object to string
        const optionString = newVariant.options
          ? Object.entries(newVariant.options)
              .map(([key, val]) => `${key}: ${val}`)
              .join(', ')
          : 'unknown variant';

        const priceNote =
          priceDiff === 0
            ? 'no price difference'
            : priceDiff > 0
              ? `+ $${priceDiff.toFixed(2)}`
              : `– $${Math.abs(priceDiff).toFixed(2)}`;

        itemSummaries.push(
          `• "${oldItem.name}" (${oldItemId}) → "${product.name} - ${optionString}" (${newItemId}) [${priceNote}]`
        );
      }

      let responseText = `Exchange processed for order ${orderId}. Here are the item-level details:\n\n${itemSummaries.join(
        '\n'
      )}\n\n`;

      if (totalPriceDiff === 0) {
        responseText += `There is no price difference. The new item(s) will be shipped within 2-3 business days to your original address.`;
      } else if (totalPriceDiff < 0) {
        const refundAmount = Math.abs(totalPriceDiff);
        responseText += `You'll receive a total refund of $${refundAmount.toFixed(
          2
        )} for the price difference.`;
      } else {
        responseText += `An additional charge of $${totalPriceDiff.toFixed(
          2
        )} will be applied to your original payment method.`;
      }


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
        },
        data: {
          orderId,
          exchanges: exchangeMapping,
          priceDifference: totalPriceDiff,
          exchangedItems,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      const errorText = `Error processing exchange: ${errorMessage}`;

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
        values: state?.values,
      };
    }
  },

  examples: [
    [
      {
        name: '{{user}}',
        content: {
          text: 'Exchange item 9612497925 for 8124970213 in order #W3847291',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I've processed your exchange request for order W3847291. The new item(s) will be shipped within 2-3 business days to your original address.",
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'I want to exchange the blue M shirt for purple XL in #W1234567',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Exchange processed for order W1234567. An additional charge of $15.00 will be applied to your original payment method.',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'Swap 6469567736 with 7382910456 from order #W2611340',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: "Exchange processed for order W2611340. You'll receive a refund of $12.50 for the price difference.",
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'Exchange multiple items in #W5744371: 1234:5678, 9012:3456',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I've processed your exchange request for order W5744371. The new item(s) will be shipped within 2-3 business days to your original address.",
        },
      },
    ],
  ] as ActionExample[][],
};
