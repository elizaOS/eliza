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

export const think: Action = {
  name: 'THINK',
  description:
    'Use this tool to think about something. It will not obtain new information or change the database, but just append the thought to the log. Use it when complex reasoning or some cache memory is needed.',
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
    // Use LLM to extract parameters with XML format
    const extractionPrompt = `Extract the thought or reasoning from the message.

User message: "${message.content.text}"

The function requires these parameters:
- thought: The agent's internal thought or reasoning (e.g., "This customer seems frustrated and needs careful handling", "The return policy might not cover this situation")

Note: Extract the complete thought or reasoning process mentioned in the message. This is for internal agent processing and chain-of-thought reasoning.

Respond with ONLY the extracted parameters in this XML format:
<response>
  <thought>extracted thought or reasoning</thought>
</response>

If no clear thought content can be found, use the entire message as the thought.`;

    try {
      // Use small model for parameter extraction
      const extractionResult = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: extractionPrompt,
      });

      // Parse XML response using parseKeyValueXml
      const parsedParams = parseKeyValueXml(extractionResult);

      const thought = parsedParams?.thought?.trim() || message.content.text?.trim();

      if (!thought) {
        // Don't expose error to user for think action
        if (callback) {
          await callback({
            text: 'Let me consider that...',
            source: message.content.source,
          });
        }
        return {
          success: false,
          text: '',
          error: 'No thought content provided',
        };
      }

      // Store the thought in state for context
      const existingThoughts = state?.values?.thoughts || [];
      const newThought = {
        content: thought,
        timestamp: new Date().toISOString(),
      };

      const updatedThoughts = [...existingThoughts, newThought];

      // Keep only the last 10 thoughts to prevent memory bloat
      const recentThoughts = updatedThoughts.slice(-10);

      // IMPORTANT: Never expose the thought content in the callback
      // Either use empty string or a subtle acknowledgment
      if (callback) {
        await callback({
          text: '', // Empty string - no user-facing message
          source: message.content.source,
        });
      }

      return {
        success: true,
        text: '', // Empty string for think action
        values: {
          thoughts: recentThoughts,
          lastThought: newThought,
        },
        data: {
          thought: newThought,
          thoughtCount: recentThoughts.length,
        },
      };
    } catch (error) {
      // Don't expose internal errors to user for think action
      if (callback) {
        await callback({
          text: 'Let me consider that...',
          source: message.content.source,
        });
      }

      return {
        success: false,
        text: '',
        error: error instanceof Error ? error.message : 'Failed to process thought',
      };
    }
  },
};
