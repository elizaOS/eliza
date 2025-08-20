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
import { composePromptFromState } from '@elizaos/core';

export const getProductDetails: Action = {
  name: 'GET_PRODUCT_DETAILS',
  description: 'Get detailed information about a product including all variants and options. Select this action only when the correct product ID has been obtained from the order.',
  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State) => {
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
    responses?: Memory[]
  ): Promise<ActionResult> => {
    try {
      const thoughtSnippets =
      responses
        ?.map((res) => res.content?.thought)
        .filter(Boolean)
        .join('\n') ?? '';
      // Get retail data from state or load from mock data
      const retailData = state?.values?.retailData || getRetailData();

      // Use LLM to extract parameters with XML format
      const extractionPrompt = `You are extracting a product ID from a customer conversation based on both the dialogue and internal reasoning.

**Conversation:**
{{recentMessages}}

**Agent Thoughts (why this action was selected):**
${thoughtSnippets}

Your task:
- Identify if the user is referring to a specific product for which they want details (e.g., to exchange, modify, ask questions about, etc.).
- Use both the conversation and the agent's internal thoughts to make this judgment.
- Extract only the most relevant 10-digit product ID, if clearly mentioned with actionable intent.

Respond strictly using this XML format:

<response>
  <product_id>10-digit product ID or empty string</product_id>
</response>

If no actionable product reference exists, leave the value empty. Do not include any commentary or explanation.`;

      const prompt = composePromptFromState({
        state,
        template: extractionPrompt,
      });

      const extractionResult = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt
      });

      // Parse XML response using parseKeyValueXml
      const parsedParams = parseKeyValueXml(extractionResult);

      console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!", parsedParams);

      const productId = parsedParams?.product_id?.trim();

      if (!productId) {
        const errorMsg =
          "The product ID is missing or invalid. Please provide a valid 10-digit product ID to proceed.";
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

      // Look up the product
      const product = retailData.products[productId];

      if (!product) {
        const errorMsg = `The product ID is missing or invalid. Please provide a valid 10-digit product ID to proceed.`;
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
      const responseText = JSON.stringify(product);

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
        data: product,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      const errorText = `Error during product lookup: ${errorMessage}`;

      if (callback) {
        await callback({
          text: errorText,
          source: message.content.source,
        });
      }

      return {
        success: false,
        text: errorText,
        error: errorMessage,
        values: state?.values,
      };
    }
  },

  examples: [
    [
      {
        name: '{{user}}',
        content: {
          text: 'Show me details for product 9523456873',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: '{"product_id":"9523456873","name":"T-Shirt","variants":{"1234567890":{"item_id":"1234567890","price":25.99,"available":true,"options":{"size":"S","color":"blue"}}}}',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'What options do you have for 8310926033?',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: '{"product_id":"8310926033","name":"Laptop Stand","variants":{"6469567736":{"item_id":"6469567736","price":45.00,"available":true,"options":{"material":"aluminum","adjustable":"yes"}}}}',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'Tell me about item 4794339885',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: '{"product_id":"4794339885","name":"Wireless Headphones","variants":{"8124970213":{"item_id":"8124970213","price":99.99,"available":true,"options":{"color":"black","noise_cancelling":"yes"}}}}',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'Get product information for 2847391056',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Error: product not found',
        },
      },
    ],
  ] as ActionExample[][],
};
