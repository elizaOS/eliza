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
  similes: ['find_user_id_by_name_zip', 'authenticate_by_name', 'verify_customer_name'],
  description: `Find and authenticate a customer using their first name, last name, and zip code.

  **Required Parameters:**
  - first_name (string): The customer's first name (e.g., "John")
  - last_name (string): The customer's last name (e.g., "Doe")  
  - zip (string): The customer's 5-digit zip code (e.g., "12345")

  **Returns:**
  - Success: Returns the user_id string and sets authentication status
  - Failure: Returns "Error: user not found" if no matching user exists

  **Authentication Priority:**
  - By default, authenticate users by EMAIL (use FIND_USER_ID_BY_EMAIL action)
  - Only use this action if:
    1. User cannot remember their email
    2. User prefers not to share email
    3. Email authentication failed
    4. User explicitly provides name and zip code for authentication

  **Action Result:**
  When successful, this action:
  - Returns the authenticated user_id
  - Sets 'authenticated: true' in state
  - Enables subsequent actions that require authentication
  - After successful authentication, you should FINISH the action loop and ask the user how they want to proceed

  **When to use:**
  - Customer needs authentication but cannot/won't provide email
  - Customer explicitly offers name and zip for verification
  - As fallback authentication method

  **Do NOT use when:**
  - Customer has already been authenticated
  - Customer can provide email (use FIND_USER_ID_BY_EMAIL instead)
  - Authentication is not required for the requested action`,
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

    // Get room-specific data for isolation in parallel tests
    const roomId = message.roomId;
    const retailData: RetailData = state?.values?.retailData || getRetailData(roomId);

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
};
