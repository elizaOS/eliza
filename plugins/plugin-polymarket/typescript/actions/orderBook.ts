/**
 * @elizaos/plugin-polymarket Order Book Actions
 *
 * Actions for retrieving order book data, prices, and spreads.
 */

import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from "@elizaos/core";
import { callLLMWithTimeout, isLLMError } from "../utils/llmHelpers";
import { initializeClobClient } from "../utils/clobClient";
import {
  getOrderBookTemplate,
  getOrderBookDepthTemplate,
  getBestPriceTemplate,
  getMidpointPriceTemplate,
  getSpreadTemplate,
} from "../templates";
import type { OrderBook } from "../types";

// =============================================================================
// Type Definitions
// =============================================================================

interface LLMTokenResult {
  tokenId?: string;
  error?: string;
}

interface LLMTokensResult {
  tokenIds?: string[];
  error?: string;
}

interface LLMPriceResult {
  tokenId?: string;
  side?: "buy" | "sell";
  error?: string;
}

interface MidpointResponse {
  mid: string;
}

interface SpreadResponse {
  spread: string;
}

// =============================================================================
// Get Order Book Summary Action
// =============================================================================

export const getOrderBookSummaryAction: Action = {
  name: "POLYMARKET_GET_ORDER_BOOK",
  similes: [
    "ORDER_BOOK",
    "GET_ORDER_BOOK",
    "SHOW_ORDER_BOOK",
    "BOOK",
    "ORDERS",
  ],
  description: "Retrieve order book summary for a specific token",

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
    logger.info("[getOrderBookSummaryAction] Handler called");

    let tokenId = "";

    try {
      const llmResult = await callLLMWithTimeout<LLMTokenResult>(
        runtime,
        state,
        getOrderBookTemplate,
        "getOrderBookSummaryAction"
      );

      if (isLLMError(llmResult) || !llmResult?.tokenId) {
        throw new Error("Token ID not found. Please specify a token ID.");
      }

      tokenId = llmResult.tokenId;

      const clobClient = await initializeClobClient(runtime);
      const orderBook = await clobClient.getOrderBook(tokenId) as OrderBook;

      // Calculate summary stats
      const topBid = orderBook.bids[0];
      const topAsk = orderBook.asks[0];
      const spread = topBid && topAsk
        ? (parseFloat(topAsk.price) - parseFloat(topBid.price)).toFixed(4)
        : "N/A";

      let responseText = `📚 **Order Book for Token ${tokenId.slice(0, 16)}...**\n\n`;

      responseText += `**Summary:**\n`;
      responseText += `• Best Bid: ${topBid ? `$${topBid.price} (${topBid.size} shares)` : "None"}\n`;
      responseText += `• Best Ask: ${topAsk ? `$${topAsk.price} (${topAsk.size} shares)` : "None"}\n`;
      responseText += `• Spread: ${spread}\n\n`;

      responseText += `**Top 5 Bids:**\n`;
      orderBook.bids.slice(0, 5).forEach((bid, i) => {
        responseText += `${i + 1}. $${bid.price} - ${bid.size} shares\n`;
      });

      responseText += `\n**Top 5 Asks:**\n`;
      orderBook.asks.slice(0, 5).forEach((ask, i) => {
        responseText += `${i + 1}. $${ask.price} - ${ask.size} shares\n`;
      });

      const responseContent: Content = {
        text: responseText,
        actions: ["POLYMARKET_GET_ORDER_BOOK"],
        data: {
          orderBook,
          tokenId,
          summary: { topBid, topAsk, spread },
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error("[getOrderBookSummaryAction] Error:", error);

      const errorContent: Content = {
        text: `❌ **Error**: ${errorMessage}\n\n**Token ID**: \`${tokenId || "not provided"}\``,
        actions: ["POLYMARKET_GET_ORDER_BOOK"],
        data: { error: errorMessage, tokenId },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw error;
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Show me the order book for token 123456" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll fetch the order book for that token.",
          action: "POLYMARKET_GET_ORDER_BOOK",
        },
      },
    ],
  ],
};

// =============================================================================
// Get Order Book Depth Action
// =============================================================================

interface DepthData {
  bids: number;
  asks: number;
}

export const getOrderBookDepthAction: Action = {
  name: "POLYMARKET_GET_ORDER_BOOK_DEPTH",
  similes: [
    "ORDER_BOOK_DEPTH",
    "DEPTH",
    "MARKET_DEPTH",
    "LIQUIDITY",
  ],
  description: "Retrieve order book depth for multiple tokens",

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
    logger.info("[getOrderBookDepthAction] Handler called");

    let tokenIds: string[] = [];

    try {
      const llmResult = await callLLMWithTimeout<LLMTokensResult>(
        runtime,
        state,
        getOrderBookDepthTemplate,
        "getOrderBookDepthAction"
      );

      if (isLLMError(llmResult) || !llmResult?.tokenIds?.length) {
        throw new Error("Token IDs not found. Please specify token IDs.");
      }

      tokenIds = llmResult.tokenIds;

      const clobClient = await initializeClobClient(runtime);
      const depths = await clobClient.getOrderBooksDepth(tokenIds) as Record<string, DepthData>;

      let responseText = `📊 **Order Book Depth**\n\n`;

      Object.entries(depths).forEach(([tid, depth]) => {
        responseText += `**Token ${tid.slice(0, 12)}...**\n`;
        responseText += `• Bid Depth: ${depth.bids}\n`;
        responseText += `• Ask Depth: ${depth.asks}\n\n`;
      });

      const responseContent: Content = {
        text: responseText,
        actions: ["POLYMARKET_GET_ORDER_BOOK_DEPTH"],
        data: {
          depths,
          tokenIds,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error("[getOrderBookDepthAction] Error:", error);

      const errorContent: Content = {
        text: `❌ **Error**: ${errorMessage}`,
        actions: ["POLYMARKET_GET_ORDER_BOOK_DEPTH"],
        data: { error: errorMessage, tokenIds },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw error;
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Get depth for tokens 123, 456, 789" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll fetch the order book depth for those tokens.",
          action: "POLYMARKET_GET_ORDER_BOOK_DEPTH",
        },
      },
    ],
  ],
};

// =============================================================================
// Get Best Price Action
// =============================================================================

export const getBestPriceAction: Action = {
  name: "POLYMARKET_GET_BEST_PRICE",
  similes: [
    "BEST_PRICE",
    "TOP_PRICE",
    "BID_PRICE",
    "ASK_PRICE",
  ],
  description: "Get the best bid or ask price for a token",

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
    logger.info("[getBestPriceAction] Handler called");

    let tokenId = "";
    let side = "buy";

    try {
      const llmResult = await callLLMWithTimeout<LLMPriceResult>(
        runtime,
        state,
        getBestPriceTemplate,
        "getBestPriceAction"
      );

      if (isLLMError(llmResult) || !llmResult?.tokenId) {
        throw new Error("Token ID not found. Please specify a token ID and side.");
      }

      tokenId = llmResult.tokenId;
      side = llmResult.side ?? "buy";

      const clobClient = await initializeClobClient(runtime);

      // Get order book to find best price
      const orderBook = await clobClient.getOrderBook(tokenId) as OrderBook;

      let bestPrice: string;
      let bestSize: string;

      if (side === "buy") {
        const topAsk = orderBook.asks[0];
        bestPrice = topAsk?.price ?? "N/A";
        bestSize = topAsk?.size ?? "N/A";
      } else {
        const topBid = orderBook.bids[0];
        bestPrice = topBid?.price ?? "N/A";
        bestSize = topBid?.size ?? "N/A";
      }

      const responseText = `💰 **Best ${side.toUpperCase()} Price**\n\n` +
        `• Token: \`${tokenId}\`\n` +
        `• Side: ${side.toUpperCase()}\n` +
        `• Best Price: $${bestPrice}\n` +
        `• Available Size: ${bestSize} shares`;

      const responseContent: Content = {
        text: responseText,
        actions: ["POLYMARKET_GET_BEST_PRICE"],
        data: {
          tokenId,
          side,
          bestPrice,
          bestSize,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error("[getBestPriceAction] Error:", error);

      const errorContent: Content = {
        text: `❌ **Error**: ${errorMessage}`,
        actions: ["POLYMARKET_GET_BEST_PRICE"],
        data: { error: errorMessage, tokenId, side },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw error;
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "What's the best buy price for token 123456?" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll get the best buy price for that token.",
          action: "POLYMARKET_GET_BEST_PRICE",
        },
      },
    ],
  ],
};

// =============================================================================
// Get Midpoint Price Action
// =============================================================================

export const getMidpointPriceAction: Action = {
  name: "POLYMARKET_GET_MIDPOINT",
  similes: [
    "MIDPOINT",
    "MID_PRICE",
    "MIDDLE_PRICE",
  ],
  description: "Get the midpoint price between best bid and ask",

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
    logger.info("[getMidpointPriceAction] Handler called");

    let tokenId = "";

    try {
      const llmResult = await callLLMWithTimeout<LLMTokenResult>(
        runtime,
        state,
        getMidpointPriceTemplate,
        "getMidpointPriceAction"
      );

      if (isLLMError(llmResult) || !llmResult?.tokenId) {
        throw new Error("Token ID not found. Please specify a token ID.");
      }

      tokenId = llmResult.tokenId;

      const clobClient = await initializeClobClient(runtime);
      const midpointResponse = await clobClient.getMidpoint(tokenId) as MidpointResponse;

      const responseText = `📍 **Midpoint Price**\n\n` +
        `• Token: \`${tokenId}\`\n` +
        `• Midpoint: $${midpointResponse.mid}`;

      const responseContent: Content = {
        text: responseText,
        actions: ["POLYMARKET_GET_MIDPOINT"],
        data: {
          tokenId,
          midpoint: midpointResponse.mid,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error("[getMidpointPriceAction] Error:", error);

      const errorContent: Content = {
        text: `❌ **Error**: ${errorMessage}`,
        actions: ["POLYMARKET_GET_MIDPOINT"],
        data: { error: errorMessage, tokenId },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw error;
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "What's the midpoint price for token 123456?" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll calculate the midpoint price for that token.",
          action: "POLYMARKET_GET_MIDPOINT",
        },
      },
    ],
  ],
};

// =============================================================================
// Get Spread Action
// =============================================================================

export const getSpreadAction: Action = {
  name: "POLYMARKET_GET_SPREAD",
  similes: [
    "SPREAD",
    "BID_ASK_SPREAD",
    "MARKET_SPREAD",
  ],
  description: "Get the bid-ask spread for a token",

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
    logger.info("[getSpreadAction] Handler called");

    let tokenId = "";

    try {
      const llmResult = await callLLMWithTimeout<LLMTokenResult>(
        runtime,
        state,
        getSpreadTemplate,
        "getSpreadAction"
      );

      if (isLLMError(llmResult) || !llmResult?.tokenId) {
        throw new Error("Token ID not found. Please specify a token ID.");
      }

      tokenId = llmResult.tokenId;

      const clobClient = await initializeClobClient(runtime);
      const spreadResponse = await clobClient.getSpread(tokenId) as SpreadResponse;

      const responseText = `📏 **Bid-Ask Spread**\n\n` +
        `• Token: \`${tokenId}\`\n` +
        `• Spread: ${spreadResponse.spread}`;

      const responseContent: Content = {
        text: responseText,
        actions: ["POLYMARKET_GET_SPREAD"],
        data: {
          tokenId,
          spread: spreadResponse.spread,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error("[getSpreadAction] Error:", error);

      const errorContent: Content = {
        text: `❌ **Error**: ${errorMessage}`,
        actions: ["POLYMARKET_GET_SPREAD"],
        data: { error: errorMessage, tokenId },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw error;
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "What's the spread for token 123456?" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll get the bid-ask spread for that token.",
          action: "POLYMARKET_GET_SPREAD",
        },
      },
    ],
  ],
};
