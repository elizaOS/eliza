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
import { RetailData, Address } from '../../types/retail';

export const modifyUserAddress: Action = {
  name: 'MODIFY_USER_ADDRESS',
  description:
    'Modify the default address of a user. The agent needs to explain the modification detail and ask for explicit user confirmation (yes/no) to proceed.',
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
    const retailData: RetailData = state?.values?.retailData || getRetailData();

    // Use LLM to extract parameters with XML format
    const extractionPrompt = `Extract the parameters from the user message for a function that modifies the default address of a user.

User message: "${message.content.text}"

The function requires these parameters:
- user_id: The user ID (e.g., "sara_doe_496")
- address1: New street address line 1
- address2: New street address line 2 (optional - if not found, use empty string)
- city: New city
- state: New state code (e.g., CA, NY)
- zip: New 5-digit zip code
- country: New country (optional - if not found, use empty string)

Respond with ONLY the extracted parameters in this XML format:
<response>
  <user_id>extracted user ID</user_id>
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

      const userId = parsedParams?.user_id?.trim();
      const address1 = parsedParams?.address1?.trim();
      const address2 = parsedParams?.address2?.trim() || '';
      const city = parsedParams?.city?.trim();
      const state = parsedParams?.state?.trim();
      const zip = parsedParams?.zip?.trim();
      const country = parsedParams?.country?.trim() || 'USA';

      if (!userId || !address1 || !city || !state || !zip) {
        const errorMsg =
          "I couldn't extract all required address information. Please provide the user ID, street address, city, state, and zip code.";
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

      // Check if user exists
      const user = retailData.users[userId];
      if (!user) {
        const errorMsg = `Error: user not found`;
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

      // Update user address
      user.address = {
        address1,
        address2,
        city,
        state,
        zip,
        country,
      };

      // Update the retail data in state
      const updatedRetailData = { ...retailData };
      updatedRetailData.users[userId] = user;

      // Return JSON string to match Python implementation
      const successMsg = JSON.stringify(user);

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
        data: user,
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
          text: 'Change sara_doe_496 address to 123 New St, Miami, FL 33101',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: '{"user_id":"sara_doe_496","name":{"first_name":"Sara","last_name":"Doe"},"email":"sara.doe496@example.com","address":{"address1":"123 New St","address2":"","city":"Miami","state":"FL","zip":"33101","country":"USA"},"payment_methods":{...}}',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'Update john_smith_123 address: 456 Park Ave, Apt 8, Seattle, WA 98101',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: '{"user_id":"john_smith_123","name":{"first_name":"John","last_name":"Smith"},"email":"john.smith123@example.com","address":{"address1":"456 Park Ave","address2":"Apt 8","city":"Seattle","state":"WA","zip":"98101","country":"USA"},"payment_methods":{...}}',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'Set new address for emma_jones_789: 789 Broadway, New York, NY 10003',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: '{"user_id":"emma_jones_789","name":{"first_name":"Emma","last_name":"Jones"},"email":"emma.jones789@example.com","address":{"address1":"789 Broadway","address2":"","city":"New York","state":"NY","zip":"10003","country":"USA"},"payment_methods":{...}}',
        },
      },
    ],
  ] as ActionExample[][],
};
