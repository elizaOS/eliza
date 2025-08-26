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

// Template for extracting user address modification parameters
const extractionTemplate = `Extract the address modification parameters from the user's message and conversation context.

{{recentMessages}}

**Previous Action Results:**
{{actionResults}}

Current user message: "{{userMessage}}"

The function requires these parameters:
- user_id: The user ID (format: "firstname_lastname_numbers", e.g., "sara_doe_496")
- address1: New street address line 1
- address2: New street address line 2 (optional - if not found, use empty string)
- city: New city
- state: New state code (e.g., CA, NY)
- zip: New 5-digit zip code  
- country: New country (optional - if not found, use "USA")
- current_user_id: The unique internal user ID (if the user is clearly logged in and referenced), otherwise leave it blank.

Note: If the user is modifying their own address, the user_id and current_user_id should be the same.

Respond with ONLY the extracted parameters in this XML format:
<response>
  <user_id>extracted user ID</user_id>
  <address1>extracted street address line 1</address1>
  <address2>extracted street address line 2 or empty string</address2>
  <city>extracted city</city>
  <state>extracted state code</state>
  <zip>extracted zip code</zip>
  <country>extracted country or USA if not specified</country>
  <current_user_id>user_abc123</current_user_id>
</response>

If any required parameter cannot be found, use empty string for that parameter.`;

export const modifyUserAddress: Action = {
  name: 'MODIFY_USER_ADDRESS',
  similes: ['modify_user_address', 'change_default_address', 'update_account_address'],
  description: `Modify the default shipping address of a user account.
  
  **Required Parameters:**
  - user_id (string): The user ID in format "firstname_lastname_numbers" (e.g., "sara_doe_496")
    If not provided, uses the authenticated user from state.
  - address1 (string): Primary street address line
  - city (string): City name
  - state (string): State code (e.g., CA, NY, TX)
  - zip (string): 5-digit postal code
  
  **Optional Parameters:**
  - address2 (string): Secondary address line (apt, suite, etc.) - defaults to empty string
  - country (string): Country code - defaults to "USA"
  
  **Returns:**
  A JSON object containing the complete updated user profile with:
  - name: Object with first_name and last_name
  - email: User's email address
  - address: Updated default shipping address
  - payment_methods: Object of saved payment methods
  - orders: Array of order IDs associated with this user
  
  **Action Prerequisites:**
  - For modifying own address: User should be authenticated first
  - For modifying another user's address: Admin privileges may be required
  
  **Security Note:**
  The agent should explain the address modification details and ask for explicit user confirmation (yes/no) before proceeding.
  
  **When to use:**
  - Customer wants to update their default shipping address
  - Customer moved to a new location
  - Customer wants to correct address mistakes
  - Before placing new orders with updated address
  
  **Do NOT use when:**
  - You need to change address for a specific order (use MODIFY_PENDING_ORDER_ADDRESS instead)
  - User account doesn't exist
  - Incomplete address information provided`,
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
    // Compose state with RECENT_MESSAGES and ACTION_STATE to get context and previous auth
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
        const errorMsg = `To proceed with modifying the user address, I need to confirm your account. Please provide your email or your name and ZIP code so I can log you in.`;
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

      let userId = parsedParams?.user_id?.trim();
      const address1 = parsedParams?.address1?.trim();
      const address2 = parsedParams?.address2?.trim() || '';
      const city = parsedParams?.city?.trim();
      const parsedState = parsedParams?.state?.trim();
      const zip = parsedParams?.zip?.trim();
      const country = parsedParams?.country?.trim() || 'USA';

      // If no specific user_id provided, use currentUserId (user modifying their own address)
      if (!userId) {
        userId = currentUserId;
      }

      if (!userId || !address1 || !city || !parsedState || !zip) {
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

      // Security check: users can only modify their own address unless they have admin privileges
      if (userId !== currentUserId) {
        const errorMsg =
          "You can only modify your own address. To modify another user's address, admin privileges are required.";
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
        state: parsedState,
        zip,
        country,
      };

      // Update the retail data in state
      const updatedRetailData = { ...retailData };
      updatedRetailData.users[userId] = user;

      // Return formatted JSON string
      const responseText = JSON.stringify(user, null, 2);

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
          lastModifiedUserId: userId,
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
