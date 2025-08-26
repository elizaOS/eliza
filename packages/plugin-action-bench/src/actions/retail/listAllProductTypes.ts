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
import { Product } from '../../types/retail';

export const listAllProductTypes: Action = {
  name: 'LIST_ALL_PRODUCT_TYPES',
  description:
    'List all available product types and their product IDs. Use this action when users want to see what products are available, especially when they want to exchange items for different variants (different size, color, or specifications of the same product). Each product type has multiple variants with unique item IDs and different options. This helps users discover products before requesting exchanges or finding specific variants. There are 50 different product types in the store catalog.',
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
    try {
      // Get retail data from state or load from mock data
      const retailData = state?.values?.retailData || getRetailData();

      // Check if the user is asking for product information, especially for exchanges
      const extractionPrompt = `Determine if the user is asking to see available products, product types, or needs product information for exchanges/variants.

User message: "${message.content.text}"

Consider these scenarios as YES:
- User wants to see what products are available
- User is asking about exchanging items for different variants (size, color, etc.)
- User wants to know what options/variants exist for products
- User is looking for product catalog or inventory
- User wants to browse available items
- User is asking "what can I exchange this for?" or similar exchange-related questions

Respond with ONLY this XML format:
<response>
  <list_products>yes or no</list_products>
</response>`;

      // Use small model for intent validation
      const extractionResult = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: extractionPrompt,
      });

      // Parse XML response
      const parsedParams = parseKeyValueXml(extractionResult);
      const shouldList = parsedParams?.list_products?.toLowerCase() === 'yes';

      if (!shouldList) {
        // This might not be the right action
        const errorMsg =
          "I'm not sure what you're looking for. Would you like to see our available products or need help with an exchange?";
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

      // Create a map of product name to product ID
      const productTypesMap: Record<string, string> = {};

      // Iterate through all products
      const products = retailData.products as Record<string, Product>;
      Object.values(products).forEach((product) => {
        productTypesMap[product.name] = product.product_id;
      });

      // Sort product names alphabetically
      const sortedProductNames = Object.keys(productTypesMap).sort();

      // Create sorted product types object to match Python implementation
      const sortedProductTypes: Record<string, string> = {};
      sortedProductNames.forEach((name) => {
        sortedProductTypes[name] = productTypesMap[name];
      });

      // Return JSON string to match Python implementation
      const responseText = JSON.stringify(sortedProductTypes);

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
        data: sortedProductTypes,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      const errorText = `Error retrieving product catalog: ${errorMessage}`;

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
          text: 'What products do you sell?',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: '{"Backpack":"1234567890","Coffee Maker":"2345678901","Headphones":"3456789012","Laptop":"4567890123","Office Chair":"5678901234","Running Shoes":"6789012345","T-Shirt":"7890123456","Water Bottle":"8901234567"}',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'I want to exchange my item for a different variant, what options do I have?',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: '{"Desk Lamp":"0123456789","Keyboard":"1234567890","Mouse":"2345678901","Notebook":"3456789012","Pen Set":"4567890123","Phone Case":"5678901234","Tablet":"6789012345","USB Hub":"7890123456"}',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'Show me what I can exchange this for',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: '{"Camera":"0987654321","External SSD":"1987654320","Fitness Tracker":"2987654319","Gaming Chair":"3987654318","HDMI Cable":"4987654317","Monitor Stand":"5987654316","Power Bank":"6987654315","Smart Watch":"7987654314"}',
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'What product types are available for different colors and sizes?',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: '{"Bluetooth Speaker":"1357924680","Charger":"2468013579","Earbuds":"3579124680","Monitor":"4680235791","Router":"5791346802","Webcam":"6802457913","Wireless Charger":"7913568024","Yoga Mat":"8024679135"}',
        },
      },
    ],
  ] as ActionExample[][],
};
