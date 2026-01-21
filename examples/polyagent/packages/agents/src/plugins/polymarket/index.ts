/**
 * Polymarket Plugin for Polyagent Agent Manager
 *
 * This plugin integrates the Polymarket prediction markets trading capabilities
 * into Polyagent agents. It wraps the @elizaos/plugin-polymarket plugin and
 * provides agent-specific configuration.
 *
 * Features:
 * - Market discovery and search
 * - Order placement (buy/sell)
 * - Position tracking
 * - Account balance management
 * - Order book analysis
 * - Market research capabilities
 */

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import polymarketPlugin, {
  checkOrderScoringAction,
  getOrderBookDepthAction,
  getOrderDetailsAction,
  getTokenInfoAction,
  PolymarketService,
  placeOrderAction,
  polymarketProvider,
  researchMarketAction,
  retrieveAllMarketsAction,
} from "@elizaos/plugin-polymarket";

export type {
  AccountBalances,
  ApiKeyCreds,
  CachedAccountState,
  Market,
  Position,
} from "@elizaos/plugin-polymarket";
export { PolymarketService } from "@elizaos/plugin-polymarket";

/**
 * Configuration for a Polymarket trading agent
 */
export interface PolymarketAgentConfig {
  /** Agent display name */
  name: string;
  /** Agent username (unique identifier) */
  username: string;
  /** Agent bio/description */
  bio: string;
  /** Profile image URL */
  profileImageUrl?: string;
  /** System prompt for the agent */
  systemPrompt: string;
  /** Trading strategy description */
  tradingStrategy: string;
  /** Risk tolerance level */
  riskTolerance: "conservative" | "moderate" | "aggressive";
  /** Maximum position size in USDC */
  maxPositionSize: number;
  /** Whether autonomous trading is enabled */
  autonomousEnabled: boolean;
  /** Interval between autonomous actions (ms) */
  tradingInterval: number;
  /** Wallet address (set after creation) */
  walletAddress?: string;
  /** Privy user ID (set after wallet creation) */
  privyUserId?: string;
}

/**
 * Get Polymarket service from runtime
 */
export function getPolymarketService(
  runtime: IAgentRuntime,
): PolymarketService | null {
  return runtime.getService("polymarket") as PolymarketService | null;
}

/**
 * Wait for Polymarket service to be available
 */
export async function waitForPolymarketService(
  runtime: IAgentRuntime,
  timeoutMs = 30000,
): Promise<PolymarketService> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const service = getPolymarketService(runtime);
    if (service) {
      return service;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error("Polymarket service not available within timeout");
}

/**
 * Polyagent Polymarket Plugin
 *
 * Provides Polymarket trading capabilities for Polyagent agents.
 * This is a wrapper around the core @elizaos/plugin-polymarket
 * with agent-specific configuration and initialization.
 */
export const polyagentPolymarketPlugin: Plugin = {
  name: "polyagent-polymarket",
  description:
    "Polymarket prediction markets integration for Polyagent agents. Enables autonomous trading, market research, and position management.",

  config: {
    // Core Polymarket config (inherited from env)
    CLOB_API_URL: process.env.CLOB_API_URL,
    POLYMARKET_PRIVATE_KEY: process.env.POLYMARKET_PRIVATE_KEY,
    EVM_PRIVATE_KEY: process.env.EVM_PRIVATE_KEY,
    CLOB_API_KEY: process.env.CLOB_API_KEY,
    CLOB_API_SECRET: process.env.CLOB_API_SECRET,
    CLOB_API_PASSPHRASE: process.env.CLOB_API_PASSPHRASE,
    POLYMARKET_ALLOW_CREATE_API_KEY:
      process.env.POLYMARKET_ALLOW_CREATE_API_KEY,
    POLYMARKET_SIGNATURE_TYPE: process.env.POLYMARKET_SIGNATURE_TYPE,
    POLYMARKET_FUNDER_ADDRESS: process.env.POLYMARKET_FUNDER_ADDRESS,
    // LLM for research features
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  },

  async init(config: Record<string, string>, runtime?: IAgentRuntime) {
    logger.info("[PolyagentPolymarket] Initializing Polymarket plugin...");

    // Initialize the base polymarket plugin
    if (polymarketPlugin.init) {
      await polymarketPlugin.init(config, runtime);
    }

    logger.info(
      "[PolyagentPolymarket] Polymarket plugin initialized successfully",
    );
  },

  // Use the Polymarket service
  services: [PolymarketService],

  // Provider for account state and context
  providers: [polymarketProvider],

  // Trading and research actions
  actions: [
    // Market discovery
    retrieveAllMarketsAction,
    // Token info (price, position, orders)
    getTokenInfoAction,
    // Order book depth
    getOrderBookDepthAction,
    // Trading
    placeOrderAction,
    // Order management
    getOrderDetailsAction,
    checkOrderScoringAction,
    // Research
    researchMarketAction,
  ],

  evaluators: [],
};

export default polyagentPolymarketPlugin;
