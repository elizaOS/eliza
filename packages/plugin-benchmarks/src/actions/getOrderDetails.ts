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

// Template for extracting order ID from conversation removed - now inline in handler
const extractionPrompt = `You are extracting an order ID from a customer conversation and previous action results.

**Conversation:**
{{recentMessages}}

{{recentActionResults}}

**Previous Action Results:**
{{actionResults}}

**Agent Thoughts (why this action was selected):**
{{thoughtSnippets}}

Your task:
1. Check if an order_id was mentioned in the conversation
2. Extract the order ID with the # prefix (e.g., #W0000000, #W5744371)
3. The '#' symbol is required at the beginning of the order ID

Look for order_id in these places (in order of priority):
- Direct mention by the customer in the conversation (e.g., "#W2611340", "order #W4817420")
- Previous action results that might contain an order_id
- Agent's reasoning/thoughts about which order to look up

Respond strictly using this XML format:

<response>
  <order_id>order ID with # prefix or empty string</order_id>
</response>

If no order_id can be found, leave the value empty. Do not include any commentary or explanation.`;

export const getOrderDetails: Action = {
  name: 'GET_ORDER_DETAILS',
  similes: ['get_order_details', 'check_order_status', 'order_status', 'track_order'],
  description: `Get the status and detailed information of a customer's order.
  
  **Required Parameter:**
  - order_id (string): The order ID with '#' prefix (e.g., #W0000000, #W5744371)
    IMPORTANT: The '#' symbol is required at the beginning of the order ID.
  
  **Returns:**
  A JSON object containing:
  - order_id: The order identifier
  - user_id: Customer's user ID
  - address: Delivery address
  - items: Array of items in the order, each containing:
    - item_id: Unique item identifier (10-digit)
    - product_id: Product identifier (10-digit) - use this with GET_PRODUCT_DETAILS action
    - quantity: Number of items
    - price: Item price
  - fulfillments: Shipping and fulfillment details
  - status: Current order status (e.g., "delivered", "processed", "shipped")
  - payment_history: Payment transaction details
  
  **Action Chaining:**
  This action returns product_id values that can be used with GET_PRODUCT_DETAILS to get full product information for exchanges or detailed inquiries.
  
  **CRITICAL for Multiple Exchanges:**
  - If customer wants to exchange ANOTHER item after an exchange was processed:
    → ALWAYS call GET_ORDER_DETAILS again to get fresh product_ids
    → Then call GET_PRODUCT_DETAILS with the new product_id
  - This ensures you have current item_ids and product_ids for each exchange
  
  **When to use:**
  - Customer asks about order status
  - Customer wants to track their order
  - Customer wants to exchange/return items (ALWAYS first step)
  - Customer mentions ANOTHER item to exchange (re-fetch order details)
  - Customer has issues with their order`,
  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State) => {
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
    responses?: Memory[]
  ): Promise<ActionResult> => {
    let enhancedState: State | undefined;

    try {
      // First, compose state with ACTION_STATE provider to get previous action results
      enhancedState = await runtime.composeState(message, ['RECENT_MESSAGES', 'ACTION_STATE']);

      const thoughtSnippets =
        responses
          ?.map((res) => res.content?.thought)
          .filter(Boolean)
          .join('\n') ?? '';

      // Get room-specific data for isolation in parallel tests
      const roomId = message.roomId;
      const retailData: RetailData =
        enhancedState?.values?.retailData || state?.values?.retailData || getRetailData(roomId);
      enhancedState.values.thoughtSnippets = thoughtSnippets;

      const prompt = composePromptFromState({
        state: enhancedState,
        template: extractionPrompt,
      });

      const extractionResult = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
      });

      // Parse XML response using parseKeyValueXml
      const parsedParams = parseKeyValueXml(extractionResult);

      console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!', parsedParams);

      const orderId = parsedParams?.order_id?.trim();

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

      // Find order in data
      const orders = retailData.orders;
      if (orderId in orders) {
        const order = orders[orderId];

        const responsePayload = {
          order_id: orderId,
          user_id: order.user_id,
          address: order.address,
          items: order.items,
          fulfillments: order.fulfillments,
          status: order.status,
          payment_history: order.payment_history,
        };

        console.log('!!!!!!!!!!!!!!!!!ORDER!!!!!!!!!!!!!!!!!!!!!!!!!', responsePayload);

        // Convert order details to readable text format
        let responseText = `Order Details:
Order ID: ${orderId}
User ID: ${order.user_id}
Status: ${order.status}

Shipping Address:
${order.address.address1}
${order.address.address2 ? order.address.address2 + '\n' : ''}${order.address.city}, ${order.address.state} ${order.address.zip}
${order.address.country}

Items (${order.items.length} total):`;

        order.items.forEach((item, index) => {
          responseText += `
${index + 1}. ${item.name}
   Item ID: ${item.item_id}
   Product ID: ${item.product_id}
   Price: $${item.price.toFixed(2)}
   Quantity: ${item.quantity || 1}`;
          if (item.options) {
            const optionStrings = Object.entries(item.options).map(
              ([key, value]) => `${key}: ${value}`
            );
            responseText += `
   Options: ${optionStrings.join(', ')}`;
          }
        });

        if (order.fulfillments && order.fulfillments.length > 0) {
          responseText += '\n\nFulfillment Information:';
          order.fulfillments.forEach((fulfillment, index) => {
            responseText += `
Shipment ${index + 1}:
   Tracking: ${fulfillment.tracking_id.join(', ')}
   Items: ${fulfillment.item_ids.join(', ')}`;
          });
        }

        if (order.payment_history && order.payment_history.length > 0) {
          responseText += '\n\nPayment History:';
          order.payment_history.forEach((payment) => {
            responseText += `
- ${payment.transaction_type}: $${payment.amount.toFixed(2)} (Method: ${payment.payment_method_id})`;
          });
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
            currentOrderId: orderId,
          },
          data: responsePayload, // parsed object
        };
      }

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
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      const errorText = `Error during order lookup: ${errorMessage}`;

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
