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
import { RetailData } from '../../types/retail';

// Template for extracting order ID and generating contextual response
const extractionTemplate = `Extract the order ID from the user message and generate an appropriate response for retrieving order details.

{{recentMessages}}

User message: "{{userMessage}}"

The function requires these parameters:
- order_id: The order ID including the # prefix (e.g., #W0000000, #W5744371)

Based on the conversation context, generate an appropriate response message assuming the order will be found. The response should:
- Acknowledge the user's request naturally
- Mention that you're checking/looking up their order
- If the user mentioned a specific concern (exchange, return, issue), acknowledge it
- Be helpful and professional

Note: The actual order details (status, items, total) will be added automatically, so focus on the conversational aspect.

Respond with ONLY the extracted parameters and response in this XML format:
<response>
  <order_id>extracted order ID with # prefix</order_id>
  <message>generated response message for when order is found</message>
</response>

If the order ID cannot be found, use empty string for that parameter.`;

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
  
  **When to use:**
  - Customer asks about order status
  - Customer wants to track their order
  - Customer wants to exchange/return items (first step to get product_ids)
  - Customer has issues with their order`,
  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State) => {
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    state = await runtime.composeState(message, ['RECENT_MESSAGES']);

    const retailData: RetailData = state?.values?.retailData || getRetailData();

    // Add userMessage to state values for template
    state.values.userMessage = message.content.text;

    // Use composePromptFromState with our template
    const extractionPrompt = composePromptFromState({
      state,
      template: extractionTemplate,
    });

    try {
      // Use small model for parameter extraction and response generation
      const extractionResult = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: extractionPrompt,
      });

      // Parse XML response using parseKeyValueXml
      const parsedParams = parseKeyValueXml(extractionResult);

      const orderId = parsedParams?.order_id?.trim();
      const generatedMessage = parsedParams?.message?.trim();

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

        const responseText = JSON.stringify(responsePayload, null, 2); // formatted JSON string

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
            retailData,
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
        content: { text: "What's the status of order #W2611340?" },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I found your order #W2611340. It's currently processed. The order contains 2 item(s) totaling $536.65.",
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'Can you check my order #W4817420?' },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I found your order #W4817420. It's currently delivered. The order contains 6 item(s) totaling $2444.59.",
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'Show me details for order #W2611340' },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I found your order #W2611340. It's currently processed. The order contains 2 item(s) totaling $536.65.",
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'Track order number #W4817420' },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I found your order #W4817420. It's currently delivered. The order contains 6 item(s) totaling $2444.59.",
        },
      },
    ],
  ] as ActionExample[][],
};
