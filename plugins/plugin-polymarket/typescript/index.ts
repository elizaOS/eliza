/**
 * @elizaos/plugin-polymarket
 *
 * Multi-language Polymarket prediction markets plugin for elizaOS.
 * This TypeScript implementation provides:
 * - Market data retrieval and browsing
 * - Order book access and price information
 * - Order placement and management
 * - Real-time WebSocket updates
 * - Integration with plugin-evm for Polygon wallet operations
 *
 * @packageDocumentation
 */

import type { Plugin } from "@elizaos/core";
import { z } from "zod";
import { logger } from "@elizaos/core";

// Re-export all types
export * from "./types";

// Re-export constants
export * from "./constants";

// Re-export templates
export * from "./templates";

// Re-export actions
export {
  retrieveAllMarketsAction,
  getSimplifiedMarketsAction,
  getMarketDetailsAction,
  getSamplingMarketsAction,
  getOrderBookSummaryAction,
  getOrderBookDepthAction,
  getBestPriceAction,
  getMidpointPriceAction,
  getSpreadAction,
  placeOrderAction,
} from "./actions";

// Re-export providers
export { polymarketProvider } from "./providers";

// Re-export services
export { PolymarketService, type PolymarketWalletData } from "./services";

// Re-export utilities
export {
  initializeClobClient,
  initializeClobClientWithCreds,
  getWalletAddress,
  callLLMWithTimeout,
  isLLMError,
} from "./utils";

// Import for plugin definition
import {
  retrieveAllMarketsAction,
  getSimplifiedMarketsAction,
  getMarketDetailsAction,
  getSamplingMarketsAction,
  getOrderBookSummaryAction,
  getOrderBookDepthAction,
  getBestPriceAction,
  getMidpointPriceAction,
  getSpreadAction,
  placeOrderAction,
} from "./actions";
import { polymarketProvider } from "./providers";
import { PolymarketService } from "./services";

/**
 * Configuration schema for the Polymarket plugin
 */
const configSchema = z.object({
  CLOB_API_URL: z
    .string()
    .url("CLOB API URL must be a valid URL")
    .optional()
    .default("https://clob.polymarket.com"),
  POLYMARKET_PRIVATE_KEY: z
    .string()
    .min(1, "Private key cannot be empty")
    .optional(),
  EVM_PRIVATE_KEY: z
    .string()
    .min(1, "Private key cannot be empty")
    .optional(),
  CLOB_API_KEY: z
    .string()
    .min(1, "CLOB API key cannot be empty")
    .optional(),
  CLOB_API_SECRET: z
    .string()
    .min(1, "CLOB API secret cannot be empty")
    .optional(),
  CLOB_API_PASSPHRASE: z
    .string()
    .min(1, "CLOB API passphrase cannot be empty")
    .optional(),
});

/**
 * Polymarket Plugin for elizaOS
 *
 * Provides comprehensive Polymarket prediction markets integration including:
 * - Market data and browsing
 * - Order book and pricing
 * - Trading operations
 * - Real-time updates via WebSocket
 */
export const polymarketPlugin: Plugin = {
  name: "polymarket",
  description: "Polymarket prediction markets integration plugin",
  config: {
    CLOB_API_URL: process.env.CLOB_API_URL,
    POLYMARKET_PRIVATE_KEY: process.env.POLYMARKET_PRIVATE_KEY,
    EVM_PRIVATE_KEY: process.env.EVM_PRIVATE_KEY,
    CLOB_API_KEY: process.env.CLOB_API_KEY,
    CLOB_API_SECRET: process.env.CLOB_API_SECRET,
    CLOB_API_PASSPHRASE: process.env.CLOB_API_PASSPHRASE,
  },
  async init(config: Record<string, string>) {
    logger.info("*** Initializing Polymarket plugin ***");
    try {
      const validatedConfig = await configSchema.parseAsync(config);

      // Check for required private key
      if (!validatedConfig.POLYMARKET_PRIVATE_KEY && !validatedConfig.EVM_PRIVATE_KEY) {
        logger.warn(
          "No private key configured (POLYMARKET_PRIVATE_KEY or EVM_PRIVATE_KEY). " +
            "Trading features will be disabled."
        );
      }

      // Set environment variables
      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value) process.env[key] = value;
      }

      logger.info("Polymarket plugin initialized successfully");
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(
          `Invalid Polymarket plugin configuration: ${error.errors.map((e) => e.message).join(", ")}`
        );
      }
      throw error;
    }
  },
  services: [PolymarketService],
  providers: [polymarketProvider],
  actions: [
    // Market actions
    retrieveAllMarketsAction,
    getSimplifiedMarketsAction,
    getMarketDetailsAction,
    getSamplingMarketsAction,
    // Order book actions
    getOrderBookSummaryAction,
    getOrderBookDepthAction,
    getBestPriceAction,
    getMidpointPriceAction,
    getSpreadAction,
    // Trading actions
    placeOrderAction,
  ],
  evaluators: [],
};

export default polymarketPlugin;
