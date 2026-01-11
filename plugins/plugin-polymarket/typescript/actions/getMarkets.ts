/**
 * @elizaos/plugin-polymarket Market Retrieval Actions
 *
 * Actions for fetching market data from Polymarket CLOB.
 */

import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import {
  getMarketTemplate,
  getSamplingMarketsTemplate,
  getSimplifiedMarketsTemplate,
  retrieveAllMarketsTemplate,
} from "../templates";
import type { Market, MarketFilters, SimplifiedMarket } from "../types";
import { initializeClobClient } from "../utils/clobClient";
import { callLLMWithTimeout, isLLMError } from "../utils/llmHelpers";

// =============================================================================
// Type Definitions
// =============================================================================

interface LLMMarketResult {
  marketId?: string;
  query?: string;
  tokenId?: string;
  error?: string;
}

interface LLMCursorResult {
  next_cursor?: string;
  error?: string;
}

// =============================================================================
// Get All Markets Action
// =============================================================================

/**
 * Retrieve all markets action for Polymarket
 */
export const retrieveAllMarketsAction: Action = {
  name: "POLYMARKET_GET_MARKETS",
  similes: [
    "GET_MARKETS",
    "LIST_MARKETS",
    "SHOW_MARKETS",
    "FETCH_MARKETS",
    "POLYMARKET_MARKETS",
    "ALL_MARKETS",
    "BROWSE_MARKETS",
    "VIEW_MARKETS",
  ],
  description: "Retrieve available prediction markets from Polymarket with optional filters",

  validate: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
    const clobApiUrl = runtime.getSetting("CLOB_API_URL");
    if (!clobApiUrl) {
      logger.warn("[retrieveAllMarketsAction] CLOB_API_URL is required");
      return false;
    }
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info("[retrieveAllMarketsAction] Handler called");

    // Extract filters using LLM
    const llmResult = await callLLMWithTimeout<MarketFilters & { error?: string }>(
      runtime,
      state,
      retrieveAllMarketsTemplate,
      "retrieveAllMarketsAction"
    );

    const filters: MarketFilters = {};
    if (llmResult && !isLLMError(llmResult)) {
      if (llmResult.category) filters.category = llmResult.category;
      if (llmResult.active !== undefined) filters.active = llmResult.active;
      if (llmResult.limit) filters.limit = llmResult.limit;
    }

    // Initialize CLOB client and fetch markets
    const clobClient = await initializeClobClient(runtime);
    const response = await clobClient.getMarkets(filters.next_cursor);
    const markets = response.data as Market[];

    // Apply client-side filters if needed
    let filteredMarkets = markets;
    if (filters.category) {
      filteredMarkets = filteredMarkets.filter(
        (m) => m.category.toLowerCase() === filters.category?.toLowerCase()
      );
    }
    if (filters.active !== undefined) {
      filteredMarkets = filteredMarkets.filter((m) => m.active === filters.active);
    }
    if (filters.limit) {
      filteredMarkets = filteredMarkets.slice(0, filters.limit);
    }

    // Format response
    let responseText = `📊 **Polymarket Markets** (${filteredMarkets.length} results)\n\n`;

    if (filteredMarkets.length === 0) {
      responseText += "No markets found matching your criteria.";
    } else {
      filteredMarkets.slice(0, 10).forEach((market, index) => {
        responseText += `**${index + 1}. ${market.question}**\n`;
        responseText += `   • Category: ${market.category}\n`;
        responseText += `   • Active: ${market.active ? "✅" : "❌"}\n`;
        responseText += `   • ID: \`${market.condition_id.slice(0, 20)}...\`\n\n`;
      });

      if (filteredMarkets.length > 10) {
        responseText += `\n_...and ${filteredMarkets.length - 10} more markets_`;
      }
    }

    const responseContent: Content = {
      text: responseText,
      actions: ["POLYMARKET_GET_MARKETS"],
      data: {
        markets: filteredMarkets,
        count: filteredMarkets.length,
        filters,
        nextCursor: response.next_cursor,
        timestamp: new Date().toISOString(),
      },
    };

    if (callback) {
      await callback(responseContent);
    }

    return responseContent;
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Show me the active prediction markets on Polymarket",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll fetch the active prediction markets from Polymarket for you.",
          action: "POLYMARKET_GET_MARKETS",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "What crypto markets are available?" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Let me get the crypto category markets from Polymarket.",
          action: "POLYMARKET_GET_MARKETS",
        },
      },
    ],
  ],
};

// =============================================================================
// Get Simplified Markets Action
// =============================================================================

/**
 * Get simplified markets with minimal data
 */
export const getSimplifiedMarketsAction: Action = {
  name: "POLYMARKET_GET_SIMPLIFIED_MARKETS",
  similes: ["SIMPLE_MARKETS", "QUICK_MARKETS", "MARKETS_SUMMARY", "BASIC_MARKETS"],
  description: "Retrieve simplified market data with minimal fields for quick overview",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return Boolean(runtime.getSetting("CLOB_API_URL"));
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info("[getSimplifiedMarketsAction] Handler called");

    const llmResult = await callLLMWithTimeout<LLMCursorResult>(
      runtime,
      state,
      getSimplifiedMarketsTemplate,
      "getSimplifiedMarketsAction"
    );

    const clobClient = await initializeClobClient(runtime);
    const response = await clobClient.getSimplifiedMarkets(llmResult?.next_cursor);
    const markets = response.data as SimplifiedMarket[];

    let responseText = `📋 **Simplified Markets** (${markets.length} results)\n\n`;

    markets.slice(0, 15).forEach((market, index) => {
      const yesToken = market.tokens[0];
      const noToken = market.tokens[1];
      responseText += `${index + 1}. Condition: \`${market.condition_id.slice(0, 16)}...\`\n`;
      responseText += `   Active: ${market.active ? "✅" : "❌"} | Closed: ${market.closed ? "✅" : "❌"}\n`;
      responseText += `   YES: \`${yesToken.token_id.slice(0, 12)}...\` | NO: \`${noToken.token_id.slice(0, 12)}...\`\n\n`;
    });

    const responseContent: Content = {
      text: responseText,
      actions: ["POLYMARKET_GET_SIMPLIFIED_MARKETS"],
      data: {
        markets,
        count: markets.length,
        nextCursor: response.next_cursor,
        timestamp: new Date().toISOString(),
      },
    };

    if (callback) {
      await callback(responseContent);
    }

    return responseContent;
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Give me a quick overview of Polymarket markets" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll get the simplified market data for you.",
          action: "POLYMARKET_GET_SIMPLIFIED_MARKETS",
        },
      },
    ],
  ],
};

// =============================================================================
// Get Market Details Action
// =============================================================================

/**
 * Get detailed information about a specific market
 */
export const getMarketDetailsAction: Action = {
  name: "POLYMARKET_GET_MARKET_DETAILS",
  similes: [
    "GET_MARKET",
    "MARKET_DETAILS",
    "SHOW_MARKET",
    "FETCH_MARKET",
    "MARKET_INFO",
    "FIND_MARKET",
    "LOOKUP_MARKET",
  ],
  description: "Retrieve detailed information about a specific Polymarket prediction market",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return Boolean(runtime.getSetting("CLOB_API_URL"));
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info("[getMarketDetailsAction] Handler called");

    const llmResult = await callLLMWithTimeout<LLMMarketResult>(
      runtime,
      state,
      getMarketTemplate,
      "getMarketDetailsAction"
    );

    if (isLLMError(llmResult)) {
      throw new Error("Market identifier not found. Please specify a condition ID.");
    }

    let conditionId = llmResult?.marketId ?? "";

    if (!conditionId) {
      const fallbackId = llmResult?.query ?? llmResult?.tokenId ?? "";
      if (fallbackId && /^0x[a-fA-F0-9]{64}$/.test(fallbackId)) {
        conditionId = fallbackId;
      } else {
        throw new Error("No valid condition ID found");
      }
    }

    const clobClient = await initializeClobClient(runtime);
    const market = (await clobClient.getMarket(conditionId)) as Market;

    if (!market) {
      throw new Error(`Market not found for condition ID: ${conditionId}`);
    }

    let responseText = `📊 **Market Details**\n\n`;
    responseText += `**${market.question}**\n\n`;
    responseText += `**Market Information:**\n`;
    responseText += `• Condition ID: \`${market.condition_id}\`\n`;
    responseText += `• Category: ${market.category}\n`;
    responseText += `• Active: ${market.active ? "✅" : "❌"}\n`;
    responseText += `• Closed: ${market.closed ? "✅" : "❌"}\n`;

    if (market.end_date_iso) {
      responseText += `• End Date: ${new Date(market.end_date_iso).toLocaleDateString()}\n`;
    }

    responseText += `\n**Trading Details:**\n`;
    responseText += `• Min Order Size: ${market.minimum_order_size}\n`;
    responseText += `• Min Tick Size: ${market.minimum_tick_size}\n`;

    if (market.tokens?.length >= 2) {
      responseText += `\n**Outcome Tokens:**\n`;
      market.tokens.forEach((token) => {
        responseText += `• ${token.outcome}: \`${token.token_id}\`\n`;
      });
    }

    const responseContent: Content = {
      text: responseText,
      actions: ["POLYMARKET_GET_MARKET_DETAILS"],
      data: {
        market,
        conditionId,
        timestamp: new Date().toISOString(),
      },
    };

    if (callback) {
      await callback(responseContent);
    }

    return responseContent;
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Show me details for market 0x123abc..." },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll retrieve the market details from Polymarket.",
          action: "POLYMARKET_GET_MARKET_DETAILS",
        },
      },
    ],
  ],
};

// =============================================================================
// Get Sampling Markets Action
// =============================================================================

/**
 * Get markets with rewards enabled (sampling markets)
 */
export const getSamplingMarketsAction: Action = {
  name: "POLYMARKET_GET_SAMPLING_MARKETS",
  similes: ["SAMPLING_MARKETS", "REWARDS_MARKETS", "INCENTIVE_MARKETS"],
  description: "Retrieve markets with rewards/incentives enabled for sampling",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return Boolean(runtime.getSetting("CLOB_API_URL"));
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info("[getSamplingMarketsAction] Handler called");

    const llmResult = await callLLMWithTimeout<LLMCursorResult>(
      runtime,
      state,
      getSamplingMarketsTemplate,
      "getSamplingMarketsAction"
    );

    const clobClient = await initializeClobClient(runtime);
    const response = await clobClient.getSamplingMarkets(llmResult?.next_cursor);
    const markets = response.data as SimplifiedMarket[];

    let responseText = `🎯 **Sampling Markets (Rewards Enabled)** (${markets.length} results)\n\n`;

    markets.slice(0, 10).forEach((market, index) => {
      responseText += `${index + 1}. Condition: \`${market.condition_id.slice(0, 16)}...\`\n`;
      responseText += `   Min Incentive Size: ${market.min_incentive_size}\n`;
      responseText += `   Max Incentive Spread: ${market.max_incentive_spread}\n\n`;
    });

    const responseContent: Content = {
      text: responseText,
      actions: ["POLYMARKET_GET_SAMPLING_MARKETS"],
      data: {
        markets,
        count: markets.length,
        nextCursor: response.next_cursor,
        timestamp: new Date().toISOString(),
      },
    };

    if (callback) {
      await callback(responseContent);
    }

    return responseContent;
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Show markets with rewards enabled" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll get the sampling markets with incentives.",
          action: "POLYMARKET_GET_SAMPLING_MARKETS",
        },
      },
    ],
  ],
};
