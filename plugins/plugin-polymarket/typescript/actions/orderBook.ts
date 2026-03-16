/**
 * @elizaos/plugin-polymarket Order Book Actions
 *
 * ## Overview
 *
 * This module provides the order book depth action for comparing liquidity
 * across multiple Polymarket tokens.
 *
 * Note: The getOrderBookSummaryAction has been consolidated into getTokenInfoAction
 * which now provides comprehensive single-token information including pricing.
 *
 * ## When to Use This Action
 *
 * ### POLYMARKET_GET_ORDER_BOOK_DEPTH
 * **Use for:** Comparing liquidity depth across multiple tokens
 * - Evaluating which markets have the most liquidity
 * - Finding markets with adequate depth for large orders
 * - Comparing market maturity across related markets
 *
 * **Example queries:**
 * - "Compare depth for tokens A, B, and C"
 * - "Which of these markets has more liquidity?"
 *
 * ## When NOT to Use This Action
 *
 * - **Single token info**: Use `getTokenInfoAction` for comprehensive single-token data
 * - **Historical prices**: Use `getPriceHistoryAction` for past price data
 * - **Market discovery**: Use `getMarketsAction` to find markets by topic
 * - **Placing orders**: Use `placeOrderAction` to execute trades
 */

import type {
  Action,
  ActionResult,
  Content,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { getOrderBookDepthTemplate } from "../templates";
import type { OrderBook } from "../types";
import {
  callLLMWithTimeout,
  initializeClobClient,
  isLLMError,
  type LLMTokensResult,
  parseOrderBookParameters,
  sendAcknowledgement,
  sendError,
} from "../utils";

// =============================================================================
// Get Order Book Depth Action
// =============================================================================

interface DepthData {
  bids: number;
  asks: number;
}

/**
 * Multi-token order book depth action for comparing liquidity.
 *
 * This action retrieves the number of bid and ask levels for multiple tokens,
 * useful for comparing relative liquidity depth across markets.
 *
 * ## Usage Examples
 *
 * ```
 * // Compare depth across three tokens
 * { tokenIds: ["123...", "456...", "789..."] }
 * ```
 *
 * ## When to Use
 *
 * - Comparing liquidity depth across multiple related markets
 * - Finding which markets have enough depth for large orders
 * - Evaluating market maturity (more levels = more active market)
 *
 * ## When NOT to Use
 *
 * - For single-token queries → use `getTokenInfoAction`
 * - For actual prices → use `getTokenInfoAction`
 * - For trading → use `placeOrderAction`
 */
export const getOrderBookDepthAction: Action = {
  name: "POLYMARKET_GET_ORDER_BOOK_DEPTH",
  similes: ["ORDER_BOOK_DEPTH", "DEPTH", "MARKET_DEPTH", "LIQUIDITY", "COMPARE_DEPTH"],
  description:
    "Retrieves order book depth (number of bid/ask levels) for multiple tokens to compare liquidity across markets. Use when comparing depth across multiple markets or finding markets with sufficient liquidity for large trades. Parameters: tokenIds (array of condition token IDs, required).",

  parameters: [
    {
      name: "tokenIds",
      description: "Array of Polymarket condition token IDs to fetch depth for",
      required: false,
      schema: {
        type: "array",
        items: { type: "string" },
      },
      examples: [["123", "456"]],
    },
  ],

  validate: async (_runtime: IAgentRuntime): Promise<boolean> => {
    // Always validate - CLOB API URL has a default fallback in initializeClobClient
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    runtime.logger.info("[getOrderBookDepthAction] Handler called");

    let tokenIds: string[] = [];

    try {
      const parsedOptions = parseOrderBookParameters(options?.parameters);
      if (parsedOptions.tokenIds?.length) {
        tokenIds = parsedOptions.tokenIds;
      } else {
        const llmResult = await callLLMWithTimeout<LLMTokensResult>(
          runtime,
          state,
          getOrderBookDepthTemplate,
          "getOrderBookDepthAction",
        );

        if (isLLMError(llmResult) || !llmResult?.tokenIds?.length) {
          await sendError(callback, "Token IDs not found. Please specify token IDs to compare.");
          return { success: false, text: "Token IDs required", error: "missing_tokens" };
        }

        tokenIds = llmResult.tokenIds;
      }

      // Send acknowledgement before API calls
      await sendAcknowledgement(
        callback,
        `Comparing order book depth for ${tokenIds.length} token(s)...`,
        {
          tokenCount: tokenIds.length,
          tokens: tokenIds.map((t) => `${t.slice(0, 12)}...`).join(", "),
        },
      );

      const clobClient = await initializeClobClient(runtime);
      // Use getOrderBooks and calculate depth from the result
      // BookParams requires token_id and side, so we need to call for each side
      const bookParams = tokenIds.flatMap((tid) => [
        { token_id: tid, side: "BUY" as const },
        { token_id: tid, side: "SELL" as const },
      ]);
      const orderBooks = await clobClient.getOrderBooks(
        bookParams as Parameters<typeof clobClient.getOrderBooks>[0],
      );
      const depths: Record<string, DepthData> = {};
      // Process results - orderBooks is an array matching bookParams order
      tokenIds.forEach((tid, idx) => {
        const buyBook = orderBooks[idx * 2];
        const sellBook = orderBooks[idx * 2 + 1];
        depths[tid] = {
          bids: (buyBook as OrderBook)?.bids?.length ?? 0,
          asks: (sellBook as OrderBook)?.asks?.length ?? 0,
        };
      });

      let responseText = `📊 **Order Book Depth Comparison**\n\n`;

      Object.entries(depths).forEach(([tid, depth]) => {
        responseText += `**Token ${tid.slice(0, 12)}...**\n`;
        responseText += `• Bid Levels: ${depth.bids}\n`;
        responseText += `• Ask Levels: ${depth.asks}\n\n`;
      });

      const responseContent: Content = {
        text: responseText,
        actions: ["POLYMARKET_GET_ORDER_BOOK_DEPTH"],
      };

      if (callback) {
        await callback(responseContent);
      }

      return {
        success: true,
        text: responseText,
        data: {
          tokenCount: String(tokenIds.length),
          depths,
          timestamp: new Date().toISOString(),
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      runtime.logger.error("[getOrderBookDepthAction] Error:", error);
      await sendError(
        callback,
        `Failed to fetch order book depth: ${errorMessage}`,
        `${tokenIds.length} token(s)`,
      );
      return { success: false, text: `Order book error: ${errorMessage}`, error: errorMessage };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Compare depth for tokens 123, 456, 789" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll fetch the order book depth for those tokens to compare liquidity.",
          action: "POLYMARKET_GET_ORDER_BOOK_DEPTH",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Which of these markets has more liquidity?" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll compare the order book depth across those markets.",
          action: "POLYMARKET_GET_ORDER_BOOK_DEPTH",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "What's the current price for token 123?" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "That's a single-token question. I'll use the token info action to get comprehensive details including pricing.",
        },
      },
    ],
  ],
};
