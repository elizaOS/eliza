import type { Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { z } from "zod";

import {
  checkOrderScoringAction,
  createApiKeyAction,
  getAccountAccessStatusAction,
  getActiveOrdersAction,
  getAllApiKeysAction,
  getBestPriceAction,
  getClobMarketsAction,
  getMarketDetailsAction,
  getMidpointPriceAction,
  getOpenMarketsAction,
  getOrderBookDepthAction,
  getOrderBookSummaryAction,
  getOrderDetailsAction,
  getPriceHistoryAction,
  getSamplingMarketsAction,
  getSimplifiedMarketsAction,
  getSpreadAction,
  getTradeHistoryAction,
  handleAuthenticationAction,
  handleRealtimeUpdatesAction,
  placeOrderAction,
  retrieveAllMarketsAction,
  revokeApiKeyAction,
  setupWebsocketAction,
} from "./actions";
import { polymarketProvider } from "./providers";
import { PolymarketService } from "./services";

const configSchema = z.object({
  CLOB_API_URL: z
    .string()
    .url("CLOB API URL must be a valid URL")
    .optional()
    .default("https://clob.polymarket.com"),
  POLYMARKET_PRIVATE_KEY: z.string().min(1, "Private key cannot be empty").optional(),
  EVM_PRIVATE_KEY: z.string().min(1, "Private key cannot be empty").optional(),
  CLOB_API_KEY: z.string().min(1, "CLOB API key cannot be empty").optional(),
  CLOB_API_SECRET: z.string().min(1, "CLOB API secret cannot be empty").optional(),
  CLOB_API_PASSPHRASE: z.string().min(1, "CLOB API passphrase cannot be empty").optional(),
});

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
    try {
      const validatedConfig = await configSchema.parseAsync(config);

      if (!validatedConfig.POLYMARKET_PRIVATE_KEY && !validatedConfig.EVM_PRIVATE_KEY) {
        logger.warn(
          "No private key configured (POLYMARKET_PRIVATE_KEY or EVM_PRIVATE_KEY). " +
            "Trading features will be disabled."
        );
      }

      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value && typeof value === "string") process.env[key] = value;
      }

      logger.info("Polymarket plugin initialized successfully");
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(
          `Invalid Polymarket plugin configuration: ${error.issues.map((e) => e.message).join(", ")}`
        );
      }
      throw error;
    }
  },
  services: [PolymarketService],
  providers: [polymarketProvider],
  actions: [
    retrieveAllMarketsAction,
    getSimplifiedMarketsAction,
    getMarketDetailsAction,
    getSamplingMarketsAction,
    getClobMarketsAction,
    getOpenMarketsAction,
    getPriceHistoryAction,
    getTradeHistoryAction,
    getOrderBookSummaryAction,
    getOrderBookDepthAction,
    getBestPriceAction,
    getMidpointPriceAction,
    getSpreadAction,
    placeOrderAction,
    getOrderDetailsAction,
    getActiveOrdersAction,
    checkOrderScoringAction,
    createApiKeyAction,
    revokeApiKeyAction,
    getAllApiKeysAction,
    getAccountAccessStatusAction,
    setupWebsocketAction,
    handleRealtimeUpdatesAction,
    handleAuthenticationAction,
  ],
  evaluators: [],
};

export default polymarketPlugin;
