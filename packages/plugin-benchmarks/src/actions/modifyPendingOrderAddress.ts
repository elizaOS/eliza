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
import { RetailData, Address, Order } from '../types/retail';

// Template for extracting address modification parameters
const extractionTemplate = `Extract the address modification parameters from the user's message and conversation context.

{{recentMessages}}

Current user message: "{{userMessage}}"

The function requires these parameters:
- order_id: The order ID with # prefix (e.g., #W0000000)
- address1: New street address line 1
- address2: New street address line 2 (optional - if not found, use empty string)
- city: New city
- state: New state code (e.g., CA, NY)
- zip: New 5-digit zip code
- country: New country (optional - if not found, use "USA")
- is_authenticated: Check if the user has been authenticated in the conversation (look for "successfully authenticated" or "authentication completed")

Based on the conversation context, extract the address change request. The user should be providing a new shipping address for their pending order.

Respond with ONLY the extracted parameters in this XML format:
<response>
  <order_id>extracted order ID with # prefix</order_id>
  <address1>extracted street address line 1</address1>
  <address2>extracted street address line 2 or empty string</address2>
  <city>extracted city</city>
  <state>extracted state code</state>
  <zip>extracted zip code</zip>
  <country>extracted country or USA if not specified</country>
  <is_authenticated>yes or no</is_authenticated>
</response>

If any required parameter cannot be found, use empty string for that parameter.`;

export const modifyPendingOrderAddress: Action = {
  name: 'MODIFY_PENDING_ORDER_ADDRESS',
  similes: ['modify_pending_order_address', 'change_shipping_address', 'update_delivery_address'],
  description: `Modify the shipping address of a pending order.
  
  **Required Parameters:**
  - order_id (string): The order ID with '#' prefix (e.g., #W0000000)
  - address1 (string): Primary street address line
  - city (string): City name
  - state (string): State code (e.g., CA, NY, TX)
  - zip (string): 5-digit postal code
  
  **Optional Parameters:**
  - address2 (string): Secondary address line (apt, suite, etc.) - defaults to empty string
  - country (string): Country code - defaults to "USA"
  
  **Returns:**
  A JSON object containing the complete updated order with:
  - order_id: The order identifier
  - user_id: Customer's user ID
  - address: Updated shipping address
  - items: Array of items in the order
  - status: Current order status (must be "pending" to modify)
  - payment_history: Payment transaction details
  
  **Action Prerequisites:**
  - User must be authenticated (currentUserId in state)
  - Order must exist and be in "pending" status
  - User must own the order (user_id matches currentUserId)
  
  **Security Note:**
  The agent should explain the address modification details and ask for explicit user confirmation (yes/no) before proceeding.
  
  **When to use:**
  - Customer wants to change shipping address before order ships
  - Customer made a mistake in their address
  - Customer wants to ship to a different location
  - Only works for orders with status "pending"
  
  **Do NOT use when:**
  - Order has already been processed, shipped, or delivered
  - User has not been authenticated
  - Trying to modify someone else's order`,
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
    // Compose state with RECENT_MESSAGES to get conversation context
    state = await runtime.composeState(message, ['RECENT_MESSAGES']);

    // Get room-specific data for isolation in parallel tests
    const roomId = message.roomId;
    const retailData: RetailData = getRetailData(roomId);

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

      const isAuthenticated = parsedParams?.is_authenticated?.toLowerCase() === 'yes';

      if (!isAuthenticated) {
        const errorMsg = `To proceed with modifying the order address, I need to verify your identity first. Please provide your email address or your name and ZIP code for authentication.`;
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
      const address1 = parsedParams?.address1?.trim();
      const address2 = parsedParams?.address2?.trim() || '';
      const city = parsedParams?.city?.trim();
      const state = parsedParams?.state?.trim();
      const zip = parsedParams?.zip?.trim();
      const country = parsedParams?.country?.trim() || 'USA';

      if (!orderId || !address1 || !city || !state || !zip) {
        const errorMsg =
          "I couldn't extract all required address information. Please provide the order ID, street address, city, state, and zip code.";
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

      // Create new address object
      const newAddress: Address = {
        address1,
        address2,
        city,
        state,
        zip,
        country,
      };

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

      // Since user is authenticated, we proceed with address modification
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

      // Update order address directly in the mutable data
      order.address = newAddress;

      // Return the modified order as JSON string
      const responseText = JSON.stringify(order);

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
