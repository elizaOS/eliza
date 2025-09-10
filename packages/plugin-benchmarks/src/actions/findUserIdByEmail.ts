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
import { getRetailData } from '../data/retail/mockData';
import { RetailData } from '../types/retail';

export const findUserIdByEmail: Action = {
  name: 'FIND_USER_ID_BY_EMAIL',
  description:
    'Find user id by email. If the user is not found, the function will return an error message.',
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
    // Get room-specific data for isolation in parallel tests
    const roomId = message.roomId;
    const retailData: RetailData = state?.values?.retailData || getRetailData(roomId);

    // Use LLM to extract email parameter
    const extractionPrompt = `Extract the email address from the user message.

User message: "${message.content.text}"

The function requires:
- email: A valid email address (e.g., "user@example.com")

Respond with ONLY the extracted parameter in this XML format:
<response>
  <email>extracted email address</email>
</response>

If no valid email address can be found, use empty string.`;

    try {
      // Use small model for parameter extraction
      const extractionResult = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: extractionPrompt,
      });

      // Parse XML response
      const parsedParams = parseKeyValueXml(extractionResult);
      const email = parsedParams?.email?.trim();

      if (!email) {
        const errorMsg =
          'I need a valid email address to find your account. Please provide your email address.';
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

      // Find user by email
      const users = retailData.users;
      for (const [userId, profile] of Object.entries(users)) {
        if (profile.email.toLowerCase() === email.toLowerCase()) {
          const successMsg = userId;
          if (callback) {
            await callback({
              text: `Thank you. I have successfully authenticated your identity using the email ${email}.`,
              source: message.content.source,
            });
          }
          return {
            success: true,
            text: successMsg,
            values: {
              currentUserId: userId,
              authenticated: true,
            },
            data: {
              userId,
              email: profile.email,
            },
          };
        }
      }

      const errorMsg = `I couldn't find an account associated with ${email}. Please verify the email address and try again.`;
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
