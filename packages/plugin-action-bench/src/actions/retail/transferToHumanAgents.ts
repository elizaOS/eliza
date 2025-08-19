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

export const transferToHumanAgents: Action = {
  name: 'TRANSFER_TO_HUMAN_AGENTS',
  description:
    "Transfer the user to a human agent, with a summary of the user's issue. Only transfer if the user explicitly asks for a human agent, or if the user's issue cannot be resolved by the agent with the available tools.",
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
    const retailData: RetailData = state?.values?.retailData || getRetailData();

    // Use LLM to extract parameters with XML format
    const extractionPrompt = `Extract the summary of the user's issue for transfer to human agent.

User message: "${message.content.text}"

The function requires these parameters:
- summary: A summary of the user's issue (e.g., "Customer needs help with damaged item", "Billing issue with recent order", "Complex technical problem with product")

Respond with ONLY the extracted parameters in this XML format:
<response>
  <summary>extracted summary of user's issue</summary>
</response>

If no specific issue can be found, summarize the general request.`;

    try {
      // Use small model for parameter extraction
      const extractionResult = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: extractionPrompt,
      });

      // Parse XML response using parseKeyValueXml
      const parsedParams = parseKeyValueXml(extractionResult);

      const summary = parsedParams?.summary?.trim() || "User's issue";

      // Return "Transfer successful" to match Python implementation
      const responseText = 'Transfer successful';

      if (callback) {
        await callback({
          text: responseText,
          source: message.content.source,
        });
      }

      // Store transfer details in state (for ElizaOS state management)
      const transferDetails = {
        summary,
        timestamp: new Date().toISOString(),
        userId: state?.values?.currentUserId || 'anonymous',
        transferRequested: true,
      };

      return {
        success: true,
        text: responseText,
        values: {
          ...state?.values,
          retailData,
          lastTransfer: transferDetails,
          transferHistory: [...(state?.values?.transferHistory || []), transferDetails],
        },
        data: transferDetails,
      };
    } catch (error) {
      const errorMsg = `Error processing transfer request: ${error instanceof Error ? error.message : 'Unknown error'}`;

      if (callback) {
        await callback({
          text: 'I apologize, but I encountered an error while processing your transfer request. Please try again or contact support directly.',
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
        content: { text: 'I need to speak to a human agent' },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Transfer successful',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'Transfer me to customer service about my damaged item' },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Transfer successful',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'This is too complex, get me a real person' },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Transfer successful',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'I want to talk to a manager about my billing issue' },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Transfer successful',
        },
      },
    ],
  ] as ActionExample[][],
};
