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
import { RetailData, Address, Order } from '../../types/retail';

export const modifyPendingOrderAddress: Action = {
  name: 'MODIFY_PENDING_ORDER_ADDRESS',
  description:
    'Modify the shipping address of a pending order. The order must be in pending status to be modified.',
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
      const errorMsg = "You don't have permission to modify this order. Please authenticate first.";
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
    const extractionPrompt = `Extract the parameters from the user message for a function that modifies the shipping address of a pending order.

User message: "${message.content.text}"

The function requires these parameters:
- order_id: The order ID with # prefix (e.g., #W0000000)
- address1: New street address line 1
- address2: New street address line 2 (optional - if not found, use empty string)
- city: New city
- state: New state code (e.g., CA, NY)
- zip: New 5-digit zip code
- country: New country (optional - if not found, use empty string)

Respond with ONLY the extracted parameters in this XML format:
<response>
  <order_id>extracted order ID with # prefix</order_id>
  <address1>extracted street address line 1</address1>
  <address2>extracted street address line 2</address2>
  <city>extracted city</city>
  <state>extracted state code</state>
  <zip>extracted zip code</zip>
  <country>extracted country</country>
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

      // Check if user owns the order
      if (order.user_id !== state.values.currentUserId) {
        const errorMsg =
          "You don't have permission to modify this order. Please authenticate first.";
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

      // Update order address
      order.address = newAddress;

      // Update the retail data in state
      const updatedRetailData = { ...retailData };
      updatedRetailData.orders[orderId] = order as Order;

      // Return the modified order as JSON string to match Python implementation
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
        content: {
          text: 'Change shipping address for #W2611340 to 123 New St, Miami, FL 33101',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: '{"order_id":"#W2611340","user_id":"user123","address":{"address1":"123 New St","address2":"","city":"Miami","state":"FL","zip":"33101","country":"USA"},"items":[...],"status":"pending"}',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'Update order #W1234567 address: 456 Park Ave, Apt 8, Seattle, WA 98101',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: '{"order_id":"#W1234567","user_id":"user456","address":{"address1":"456 Park Ave","address2":"Apt 8","city":"Seattle","state":"WA","zip":"98101","country":"USA"},"items":[...],"status":"pending"}',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'Ship #W5744371 to 789 Broadway, New York, NY 10003 instead',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: '{"order_id":"#W5744371","user_id":"user789","address":{"address1":"789 Broadway","address2":"","city":"New York","state":"NY","zip":"10003","country":"USA"},"items":[...],"status":"pending"}',
        },
      },
    ],
  ] as ActionExample[][],
};
