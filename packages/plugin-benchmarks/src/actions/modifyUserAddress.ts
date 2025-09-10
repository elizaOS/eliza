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
- is_authenticated: Check if the user has been authenticated in the conversation (look for "successfully authenticated" or "authentication completed")

Note: If user_id is not provided, we'll modify the authenticated user's address.

Respond with ONLY the extracted parameters in this XML format:
<response>
  <user_id>extracted user ID or empty string if not found</user_id>
  <address1>extracted street address line 1</address1>
  <address2>extracted street address line 2 or empty string</address2>
  <city>extracted city</city>
  <state>extracted state code</state>
  <zip>extracted zip code</zip>
  <country>extracted country or USA if not specified</country>
  <is_authenticated>yes or no</is_authenticated>
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
        const errorMsg = `To proceed with modifying the user address, I need to verify your identity first. Please provide your email address or your name and ZIP code for authentication.`;
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

      let userId = parsedParams?.user_id?.trim();
      const address1 = parsedParams?.address1?.trim();
      const address2 = parsedParams?.address2?.trim() || '';
      const city = parsedParams?.city?.trim();
      const parsedState = parsedParams?.state?.trim();
      const zip = parsedParams?.zip?.trim();
      const country = parsedParams?.country?.trim() || 'USA';

      // If no specific user_id provided, we cannot determine which user to modify
      // In a real system, we'd get this from the session
      if (!userId) {
        // Try to extract from recent authentication messages
        const recentMessages = state?.values?.recentMessages || '';
        const userIdMatch = recentMessages.match(/user_id[: ]+([a-zA-Z_]+_\d+)/i);
        if (userIdMatch && userIdMatch[1]) {
          userId = userIdMatch[1];
        }
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

      // Since user is authenticated, we proceed with address modification
      // In a real system, we'd verify they can modify this specific user through session/permissions

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

      // Update user address directly in the mutable data
      user.address = {
        address1,
        address2,
        city,
        state: parsedState,
        zip,
        country,
      };

      // Return formatted JSON string
      const responseText = JSON.stringify(user);

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
};
