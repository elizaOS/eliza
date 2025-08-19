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
import { RetailData } from '../../types/retail';

export const getUserDetails: Action = {
  name: 'GET_USER_DETAILS',
  description:
    'Get user details by user id. If the user is not found, the function will return an error message.',
  validate: async (_runtime: IAgentRuntime, _message: Memory, state?: State) => {
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

    // Use LLM to extract user ID if mentioned in message
    const extractionPrompt = `Extract the user ID from the user message if present.

User message: "${message.content.text}"

The function looks for:
- user_id: A user ID in the format "firstname_lastname_numbers" (e.g., "john_doe_1234")

Respond with ONLY the extracted parameter in this XML format:
<response>
  <user_id>extracted user id</user_id>
</response>

If no user ID is found in the message, use empty string.`;

    try {
      // Use small model for parameter extraction
      const extractionResult = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: extractionPrompt,
      });

      // Parse XML response
      const parsedParams = parseKeyValueXml(extractionResult);
      let userId = parsedParams?.user_id?.trim();

      // If no user ID in message, use current authenticated user
      if (!userId) {
        userId = state?.values?.currentUserId;
      }

      if (!userId) {
        const errorMsg =
          'I need to authenticate you first. Please provide your email or name and zip code.';
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

      const userProfile = retailData.users[userId];
      if (!userProfile) {
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

      // Return JSON string to match Python implementation
      const responseText = JSON.stringify(userProfile);

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
          retailData,
        },
        data: userProfile,
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
        content: { text: 'Get user details' },
      },
      {
        name: '{{agent}}',
        content: {
          text: '{"user_id":"noah_brown_6181","name":{"first_name":"Noah","last_name":"Brown"},"email":"noah.brown7922@example.com","address":{"address1":"986 Sunset Drive","address2":"Suite 259","city":"Denver","state":"CO","zip":"80279","country":"USA"},"payment_methods":{"paypal_5727330":{"source":"paypal"},"credit_card_7815826":{"source":"credit_card","brand":"mastercard","last_four":"9212"}}}',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'Show me details for noah_brown_6181' },
      },
      {
        name: '{{agent}}',
        content: {
          text: '{"user_id":"noah_brown_6181","name":{"first_name":"Noah","last_name":"Brown"},"email":"noah.brown7922@example.com","address":{"address1":"986 Sunset Drive","address2":"Suite 259","city":"Denver","state":"CO","zip":"80279","country":"USA"},"payment_methods":{"paypal_5727330":{"source":"paypal"},"credit_card_7815826":{"source":"credit_card","brand":"mastercard","last_four":"9212"}}}',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: "What's the profile of james_li_5688?" },
      },
      {
        name: '{{agent}}',
        content: {
          text: '{"user_id":"james_li_5688","name":{"first_name":"James","last_name":"Li"},"email":"james.li2468@example.com","address":{"address1":"258 Oak Street","address2":"Apt 814","city":"Brooklyn","state":"NY","zip":"10083","country":"USA"},"payment_methods":{"paypal_1234567":{"source":"paypal"},"credit_card_7654321":{"source":"credit_card","brand":"visa","last_four":"7548"}}}',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'Get my account information' },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'I need to authenticate you first. Please provide your email or name and zip code.',
        },
      },
    ],
  ] as ActionExample[][],
};
