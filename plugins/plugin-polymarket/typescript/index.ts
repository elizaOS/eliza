import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { z } from "zod";

import {
  checkOrderScoringAction,
  getOrderBookDepthAction,
  getOrderDetailsAction,
  getTokenInfoAction,
  placeOrderAction,
  researchMarketAction,
  retrieveAllMarketsAction,
} from "./actions";
import { polymarketProvider } from "./providers";
import { PolymarketService } from "./services";
import { researchTaskWorker } from "./workers";

export { ACCOUNT_STATE_TTL_MS, DEFAULT_CLOB_API_URL, POLYGON_CHAIN_ID } from "./constants";
export { ResearchStorageService } from "./services";
export type {
  AccountBalances,
  ApiKeyCreds,
  AuthenticationStatus,
  BalanceAllowance,
  CachedAccountState,
  Market,
  MarketResearch,
  MarketsResponse,
  OrderBook,
  OrderResponse,
  Position,
  ResearchRecommendation,
  ResearchResult,
  ResearchStatus,
  ResearchTaskMetadata,
  SimplifiedMarket,
  SimplifiedMarketsResponse,
  StartResearchParams,
  Token,
} from "./types";
export { ResearchStatus as ResearchStatusEnum } from "./types";
export {
  getWalletAddress,
  initializeClobClient,
  initializeClobClientWithCreds,
} from "./utils/clobClient";
export { RESEARCH_TASK_NAME, researchTaskWorker, TRADE_EVALUATION_TASK_NAME } from "./workers";

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
  POLYMARKET_ALLOW_CREATE_API_KEY: z.string().optional().default("true"),
  POLYMARKET_PROVIDER_STRICT: z.string().optional().default("true"),
  POLYMARKET_PROVIDER_CACHE_TTL_MS: z.string().optional(),
});

export const polymarketPlugin: Plugin = {
  name: "polymarket",
  description: "Polymarket prediction markets integration plugin with deep research capabilities",
  config: {
    CLOB_API_URL: process.env.CLOB_API_URL,
    POLYMARKET_PRIVATE_KEY: process.env.POLYMARKET_PRIVATE_KEY,
    EVM_PRIVATE_KEY: process.env.EVM_PRIVATE_KEY,
    CLOB_API_KEY: process.env.CLOB_API_KEY,
    CLOB_API_SECRET: process.env.CLOB_API_SECRET,
    CLOB_API_PASSPHRASE: process.env.CLOB_API_PASSPHRASE,
    POLYMARKET_ALLOW_CREATE_API_KEY: process.env.POLYMARKET_ALLOW_CREATE_API_KEY,
    POLYMARKET_PROVIDER_STRICT: process.env.POLYMARKET_PROVIDER_STRICT,
    POLYMARKET_PROVIDER_CACHE_TTL_MS: process.env.POLYMARKET_PROVIDER_CACHE_TTL_MS,
    // OpenAI is optional but required for research features
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  },
  async init(config: Record<string, string>, runtime?: IAgentRuntime) {
    try {
      const validatedConfig = await configSchema.parseAsync(config);

      if (!validatedConfig.POLYMARKET_PRIVATE_KEY && !validatedConfig.EVM_PRIVATE_KEY) {
        logger.warn(
          "No private key configured (POLYMARKET_PRIVATE_KEY or EVM_PRIVATE_KEY). " +
            "Trading features will be disabled.",
        );
      }

      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value && typeof value === "string") process.env[key] = value;
      }

      // Register the research task worker if runtime is available
      if (runtime) {
        runtime.registerTaskWorker(researchTaskWorker);
        logger.info("Polymarket research task worker registered");

        // Check if OpenAI is configured for research
        const openaiKey = runtime.getSetting("OPENAI_API_KEY");
        if (!openaiKey) {
          logger.warn("OPENAI_API_KEY not configured. Deep research features will be unavailable.");
        }
      }

      logger.info("Polymarket plugin initialized successfully");
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(
          `Invalid Polymarket plugin configuration: ${error.issues.map((e) => e.message).join(", ")}`,
        );
      }
      throw error;
    }
  },
  services: [PolymarketService],
  providers: [polymarketProvider],
  actions: [
    // Market discovery & search (unified action using Gamma API)
    // Handles both keyword searches ("find miami heat") and category browsing ("show sports markets")
    retrieveAllMarketsAction,
    // Single-token comprehensive info (market details, pricing, price history, user position/orders)
    getTokenInfoAction,
    // Multi-token depth comparison
    getOrderBookDepthAction,
    // Trading
    placeOrderAction,
    // Order lookup
    getOrderDetailsAction,
    // Order scoring check (for specific/historical orders - active orders shown in provider)
    checkOrderScoringAction,
    // Deep market research
    researchMarketAction,
    // Note: Account state (balances, active orders, trades, positions, order scoring)
    // is automatically provided by polymarketProvider via the service's cached state.
    // This data refreshes on startup and every 30 minutes.
  ],
  evaluators: [],
};

export default polymarketPlugin;
