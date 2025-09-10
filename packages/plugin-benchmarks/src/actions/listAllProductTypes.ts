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
import { Product } from '../types/retail';

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
      // Get room-specific data for isolation in parallel tests
      const roomId = message.roomId;
      const retailData = state?.values?.retailData || getRetailData(roomId);

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

      // Convert product types to readable text format
      let responseText = `Available Product Types (${sortedProductNames.length} total):

`;
      sortedProductNames.forEach((name, index) => {
        responseText += `${index + 1}. ${name} - Product ID: ${productTypesMap[name]}\n`;
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
          sortedProductTypes,
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
      };
    }
  },
};
