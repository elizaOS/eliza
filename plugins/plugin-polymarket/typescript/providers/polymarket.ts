/**
 * @elizaos/plugin-polymarket Providers
 *
 * Context providers for Polymarket data.
 */

import {
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";
import { DEFAULT_CLOB_API_URL, POLYGON_CHAIN_ID } from "../constants";

/**
 * Provider for Polymarket market context
 */
export const polymarketProvider: Provider = {
  name: "POLYMARKET_PROVIDER",
  description: "Provides current Polymarket market information and context",

  get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
    try {
      const clobApiUrl = runtime.getSetting("CLOB_API_URL") || DEFAULT_CLOB_API_URL;
      const hasPrivateKey = Boolean(
        runtime.getSetting("POLYMARKET_PRIVATE_KEY") ||
          runtime.getSetting("EVM_PRIVATE_KEY") ||
          runtime.getSetting("WALLET_PRIVATE_KEY")
      );
      const hasApiCreds = Boolean(
        runtime.getSetting("CLOB_API_KEY") && runtime.getSetting("CLOB_API_SECRET")
      );

      const featuresAvailable: string[] = ["market_data", "price_feeds", "order_book"];
      if (hasPrivateKey) {
        featuresAvailable.push("wallet_operations");
      }
      if (hasApiCreds) {
        featuresAvailable.push("authenticated_trading", "order_management");
      }

      return {
        text:
          `Connected to Polymarket CLOB at ${clobApiUrl} on Polygon (Chain ID: ${POLYGON_CHAIN_ID}). ` +
          `Features available: ${featuresAvailable.join(", ")}.`,
        values: {
          clobApiUrl,
          chainId: POLYGON_CHAIN_ID,
          serviceStatus: "active",
          hasPrivateKey,
          hasApiCreds,
          featuresAvailable,
        },
        data: {
          timestamp: new Date().toISOString(),
          service: "polymarket",
        },
      };
    } catch (error) {
      logger.error("Error in Polymarket provider:", error);
      return {
        text: "Polymarket service is currently unavailable.",
        values: {
          serviceStatus: "error",
          error: error instanceof Error ? error.message : "Unknown error",
        },
        data: {
          timestamp: new Date().toISOString(),
          service: "polymarket",
        },
      };
    }
  },
};
