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

export const getUserDetails: Action = {
  name: 'GET_USER_DETAILS',
  similes: ['get_user_details', 'user_profile', 'account_details', 'customer_info'],
  description: `Get comprehensive user account details and profile information.
  
  **Optional Parameter:**
  - user_id (string): The user ID in format "firstname_lastname_numbers" (e.g., "john_doe_1234")
    If not provided, the action will use the authenticated user from previous actions.
  
  **Returns:**
  A JSON object containing:
  - name: Object with first_name and last_name
  - email: User's email address
  - address: Complete shipping address including:
    - address1: Primary address line
    - address2: Secondary address line (apt, suite, etc.)
    - city: City name
    - state/province: State or province code
    - zip: Postal code
    - country: Country code (e.g., "USA")
  - payment_methods: Object of saved payment methods, each containing:
    - source: Payment type (e.g., "paypal", "credit_card")
    - brand: Card brand if applicable (e.g., "visa", "mastercard")
    - last_four: Last 4 digits of card if applicable
  - orders: Array of order IDs associated with this user
  
  **Action Prerequisites:**
  - User must be authenticated first using one of:
    1. FIND_USER_ID_BY_EMAIL action (preferred)
    2. FIND_USER_ID_BY_NAME_ZIP action (fallback)
  - These authentication actions store currentUserId in state for subsequent use
  
  **Action Chaining:**
  - ALWAYS follows authentication actions (FIND_USER_ID_BY_EMAIL or FIND_USER_ID_BY_NAME_ZIP)
  - Can be used before order or payment method operations to verify user details
  
  **When to use:**
  - Customer asks about their account information
  - Customer needs to verify their profile details
  - Customer wants to see their saved payment methods
  - Customer asks about their shipping address
  - Before processing updates to user information
  - To display all orders associated with the account
  
  **Do NOT use when:**
  - User has not been authenticated yet
  - You need order details (use GET_ORDER_DETAILS instead)
  - You only need to verify identity (authentication actions already confirm this)`,
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
    // Compose state with RECENT_MESSAGES and ACTION_STATE to get previous authentication results
    const enhancedState = await runtime.composeState(message, ['RECENT_MESSAGES', 'ACTION_STATE']);

    // Get room-specific data for isolation in parallel tests
    const roomId = message.roomId;
    const retailData: RetailData =
      enhancedState?.values?.retailData || state?.values?.retailData || getRetailData(roomId);

    // Create extraction prompt template
    const extractionTemplate = `Extract the user ID from the conversation and previous action results.

{{recentMessages}}

**Previous Action Results:**
{{actionResults}}

Current user message: "{{userMessage}}"

Your task:
1. First, check if a user_id was stored from previous authentication actions (FIND_USER_ID_BY_EMAIL or FIND_USER_ID_BY_NAME_ZIP)
   - Look for currentUserId in the state values
   - Look for userId in previous action results
2. If not found, check if the user explicitly mentioned a user_id in the current message
   - Format: "firstname_lastname_numbers" (e.g., "john_doe_1234")

Priority order for finding user_id:
1. currentUserId from authentication actions (most reliable)
2. Direct user_id mention in current message
3. userId from any previous action result

Respond with ONLY the extracted parameter in this XML format:
<response>
  <user_id>extracted user id or empty string</user_id>
</response>

If no user ID can be found, use empty string.`;

    try {
      // Add userMessage to state values for template
      enhancedState.values.userMessage = message.content.text;

      // Use composePromptFromState with our template
      const extractionPrompt = composePromptFromState({
        state: enhancedState,
        template: extractionTemplate,
      });

      // Use small model for parameter extraction
      const extractionResult = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: extractionPrompt,
      });

      // Parse XML response
      const parsedParams = parseKeyValueXml(extractionResult);
      let userId = parsedParams?.user_id?.trim();

      // Fallback to currentUserId from state if not found
      if (!userId) {
        userId = enhancedState?.values?.currentUserId || state?.values?.currentUserId;
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

      // Convert user profile to readable text format
      let responseText = `User Profile:
Name: ${userProfile.name.first_name} ${userProfile.name.last_name}
Email: ${userProfile.email}

Shipping Address:
${userProfile.address.address1}
${userProfile.address.address2 ? userProfile.address.address2 + '\n' : ''}${userProfile.address.city}, ${userProfile.address.state} ${userProfile.address.zip}
${userProfile.address.country}

Payment Methods:`;

      const paymentMethods = Object.entries(userProfile.payment_methods);
      if (paymentMethods.length > 0) {
        paymentMethods.forEach(([id, method]) => {
          responseText += `\n- ${id}: ${method.source}`;
          if ('brand' in method && method.brand) {
            responseText += ` (${method.brand} ****${method.last_four})`;
          }
          if ('balance' in method && method.balance !== undefined) {
            responseText += ` (Balance: $${method.balance.toFixed(2)})`;
          }
        });
      } else {
        responseText += '\nNo payment methods on file';
      }

      if ('orders' in userProfile && Array.isArray(userProfile.orders)) {
        responseText += `\n\nOrders (${userProfile.orders.length} total):`;
        userProfile.orders.forEach((orderId) => {
          responseText += `\n- ${orderId}`;
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
          lastRetrievedUserId: userId,
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
};
