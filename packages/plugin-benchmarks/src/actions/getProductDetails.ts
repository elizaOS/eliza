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
import { composePromptFromState } from '@elizaos/core';
import { ProductVariant } from '../types/retail';

export const getProductDetails: Action = {
  name: 'GET_PRODUCT_DETAILS',
  description: `Get the inventory details and all variants of a specific product.
  
  **Required Parameter:**
  - product_id (string): The 10-digit product identifier (e.g., '9523456873', '6086499569')
    IMPORTANT: Product ID is different from item ID. Product ID represents the product type, while item ID is a specific variant.
  
  **Returns:**
  A JSON object containing:
  - product_id: The product identifier
  - name: Product name/description
  - variants: Object of available variants, each keyed by item_id containing:
    - item_id: Unique identifier for this specific variant (10-digit)
    - price: Current price for this variant
    - available: Boolean indicating if in stock
    - options: Object with variant-specific attributes like:
      - size: S, M, L, XL, etc.
      - color: blue, black, red, etc.
      - material: aluminum, plastic, etc.
      - Other product-specific options
  
  **Action Prerequisites:**
  - Product ID must be obtained first, typically from:
    1. GET_ORDER_DETAILS action (returns product_id for each item in an order)
    2. Customer explicitly providing a product ID
    3. Previous conversation context
  
  **Action Chaining for Exchanges:**
  - ALWAYS follows GET_ORDER_DETAILS when handling exchanges
  - For SECOND item exchange: GET_ORDER_DETAILS → GET_PRODUCT_DETAILS (new product_id)
  - Never reuse old product_id from previous exchanges
  
  **When to use:**
  - AFTER GET_ORDER_DETAILS when customer wants to exchange
  - Customer asks about product variants/options
  - Customer needs product specifications
  - Checking inventory for a specific product
  
  **Do NOT use when:**
  - You don't have a valid 10-digit product_id
  - Customer is only asking about their order (use GET_ORDER_DETAILS instead)
  - You haven't fetched fresh order details for a new exchange request`,
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
    let enhancedState: State | undefined;

    try {
      // First, compose state with ACTION_STATE provider to get previous action results
      enhancedState = await runtime.composeState(message, ['RECENT_MESSAGES', 'ACTION_STATE']);

      const thoughtSnippets =
        responses
          ?.map((res) => res.content?.thought)
          .filter(Boolean)
          .join('\n') ?? '';

      // Get room-specific data for isolation in parallel tests
      const roomId = message.roomId;
      const retailData =
        enhancedState?.values?.retailData || state?.values?.retailData || getRetailData(roomId);

      // Use LLM to extract parameters with XML format
      const extractionPrompt = `You are extracting a product ID from a customer conversation and previous action results.

**Conversation:**
{{recentMessages}}

**Previous Action Results:**
{{actionResults}}

{{recentActionResults}}

**Agent Thoughts (why this action was selected):**
${thoughtSnippets}

Your task:
1. Check if a product_id was returned from a previous GET_ORDER_DETAILS action
2. If not, check if the user directly mentioned a 10-digit product ID
3. Extract the most relevant product_id for the customer's current request

Common scenario: Customer asks to exchange an item → GET_ORDER_DETAILS returns order with product_ids → Use that product_id here

Look for product_id in these places (in order of priority):
- Previous GET_ORDER_DETAILS result (in the "items" array, each item has a "product_id" field)
- Direct mention by the customer in the conversation
- Agent's reasoning/thoughts about which product to look up

Respond strictly using this XML format:

<response>
  <product_id>10-digit product ID or empty string</product_id>
</response>

If no product_id can be found, leave the value empty. Do not include any commentary or explanation.`;

      const prompt = composePromptFromState({
        state: enhancedState,
        template: extractionPrompt,
      });

      const extractionResult = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
      });

      // Parse XML response using parseKeyValueXml
      const parsedParams = parseKeyValueXml(extractionResult);

      console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!', parsedParams);

      const productId = parsedParams?.product_id?.trim();

      if (!productId) {
        const errorMsg =
          'The product ID is missing or invalid. Please provide a valid 10-digit product ID to proceed.';
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

      console.log('!!!!!!!!!!!!!!!!!PRODUCT!!!!!!!!!!!!!!!!!!!!!!!!!', product);

      // Convert product details to readable text format
      let responseText = `Product Details:
Product ID: ${product.product_id}
Name: ${product.name}

Available Variants (${Object.keys(product.variants).length} total):`;

      Object.entries(product.variants).forEach(([itemId, variant], index) => {
        const v = variant as ProductVariant;
        responseText += `
${index + 1}. Item ID: ${itemId}
   Price: $${v.price.toFixed(2)}
   Available: ${v.available ? 'Yes' : 'No'}`;
        if (v.options) {
          const optionStrings = Object.entries(v.options).map(([key, value]) => `${key}: ${value}`);
          responseText += `
   Options: ${optionStrings.join(', ')}`;
        }
      });

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
          lastProductId: productId,
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
      };
    }
  },
};
