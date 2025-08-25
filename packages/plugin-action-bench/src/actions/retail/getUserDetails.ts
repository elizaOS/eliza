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

    const retailData: RetailData =
      enhancedState?.values?.retailData || state?.values?.retailData || getRetailData();

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

      // Return complete user profile as JSON string
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
          ...enhancedState?.values,
          ...state?.values,
          retailData,
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
  examples: [
    [
      {
        name: '{{user}}',
        content: { text: 'Show me my account details' },
      },
      {
        name: '{{agent}}',
        content: {
          text: '{"name":{"first_name":"Mei","last_name":"Kovacs"},"address":{"address1":"317 Elm Street","address2":"Suite 461","city":"Charlotte","state":"NC","zip":"28236","country":"USA"},"email":"mei.kovacs8232@example.com","payment_methods":{"paypal_7644869":{"source":"paypal","id":"paypal_7644869"}},"orders":["#W6390527","#W7800651","#W8065207"]}',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'Can you get my profile information?' },
      },
      {
        name: '{{agent}}',
        content: {
          text: '{"name":{"first_name":"Noah","last_name":"Brown"},"address":{"address1":"986 Sunset Drive","address2":"Suite 259","city":"Denver","state":"CO","zip":"80279","country":"USA"},"email":"noah.brown7922@example.com","payment_methods":{"paypal_5727330":{"source":"paypal"},"credit_card_7815826":{"source":"credit_card","brand":"mastercard","last_four":"9212"}},"orders":["#W2611340","#W3847291"]}',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: "What's the profile of user james_li_5688?" },
      },
      {
        name: '{{agent}}',
        content: {
          text: '{"name":{"first_name":"James","last_name":"Li"},"address":{"address1":"258 Oak Street","address2":"Apt 814","city":"Brooklyn","state":"NY","zip":"10083","country":"USA"},"email":"james.li2468@example.com","payment_methods":{"paypal_1234567":{"source":"paypal"},"credit_card_7654321":{"source":"credit_card","brand":"visa","last_four":"7548"}},"orders":["#W1234567","#W7654321"]}',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'Show me my saved payment methods and shipping address' },
      },
      {
        name: '{{agent}}',
        content: {
          text: '{"name":{"first_name":"Sophia","last_name":"Davis"},"address":{"address1":"456 Pine Avenue","address2":"","city":"Seattle","state":"WA","zip":"98101","country":"USA"},"email":"sophia.davis1357@example.com","payment_methods":{"credit_card_8901234":{"source":"credit_card","brand":"amex","last_four":"5678"},"paypal_4567890":{"source":"paypal"}},"orders":["#W8901234","#W4567890","#W1122334"]}',
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
