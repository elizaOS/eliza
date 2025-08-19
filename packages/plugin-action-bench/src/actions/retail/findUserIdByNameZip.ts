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

// Template for extracting parameters and generating response
const extractionTemplate = `Extract the parameters from the user message for a function that finds a user by their name and zip code, and generate an appropriate response message.

{{recentMessages}}

User message: "{{userMessage}}"

The function requires these parameters:
- first_name: The first name of the customer (e.g., "John")  
- last_name: The last name of the customer (e.g., "Doe")
- zip: The 5-digit zip code of the customer (e.g., "12345")

Based on the conversation context, also generate an appropriate response message that:
- Confirms the authentication if successful
- Naturally continues the conversation based on what the user was asking about
- Is helpful and professional

Respond with ONLY the extracted parameters and response in this XML format:
<response>
  <first_name>extracted first name</first_name>
  <last_name>extracted last name</last_name>
  <zip>extracted zip code</zip>
  <message>generated response message</message>
</response>

If any parameter cannot be found, use empty string for that parameter.`;

export const findUserIdByNameZip: Action = {
  name: 'FIND_USER_ID_BY_NAME_ZIP',
  description:
    'Find user id by name and zip code. If the user is not found, the function will return an error message.',
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

      const firstName = parsedParams?.first_name?.trim();
      const lastName = parsedParams?.last_name?.trim();
      const zip = parsedParams?.zip?.trim();
      const generatedMessage = parsedParams?.message?.trim();

      if (!firstName || !lastName || !zip) {
        const errorMsg = 'Error: Could not extract all required parameters from the message';
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

      // Find user by name and zip
      const users = retailData.users;
      for (const [userId, profile] of Object.entries(users)) {
        if (
          profile.name.first_name.toLowerCase() === firstName.toLowerCase() &&
          profile.name.last_name.toLowerCase() === lastName.toLowerCase() &&
          profile.address.zip === zip
        ) {
          if (callback) {
            await callback({
              text:
                generatedMessage ||
                `Thank you, ${profile.name.first_name}. I have successfully authenticated your identity.`,
              source: message.content.source,
            });
          }
          return {
            success: true,
            text: userId,
            values: {
              ...state?.values,
              retailData,
              currentUserId: userId,
              authenticated: true,
            },
            data: {
              userId,
              name: `${profile.name.first_name} ${profile.name.last_name}`,
              zip: profile.address.zip,
            },
          };
        }
      }

      const errorMsg = `I couldn't find a user named ${firstName} ${lastName} with zip code ${zip}. Please verify your information and try again.`;
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
        content: {
          text: "Hello there! I've just received my order with the number W2378156, and I'd like to inquire about making a couple of exchanges.",
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Sure, I can help you with that. First, I need to authenticate your identity. Could you please provide your email address?',
        },
      },
      {
        name: '{{user}}',
        content: {
          text: 'Apologies, but I am not comfortable sharing my email in chat. However, I can confirm the name on the order is Yusuf Rossi and shipping zip code as 19122. Would that be sufficient?',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: "Thank you, Yusuf. I have successfully authenticated your identity. Now, let's proceed with the exchange. Could you please provide the details of the items you want to exchange and the new items you want in return?",
        },
      },
    ],
  ] as ActionExample[][],
};
