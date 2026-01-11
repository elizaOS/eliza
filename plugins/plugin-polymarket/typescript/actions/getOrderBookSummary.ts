import {
  type Action,
  type ActionResult,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import type { ClobClient, OrderBookSummary } from "@polymarket/clob-client";
import { getOrderBookTemplate } from "../templates";
import { initializeClobClient } from "../utils/clobClient";
import { callLLMWithTimeout, isLLMError } from "../utils/llmHelpers";

interface LLMOrderBookSummaryResult {
  tokenId?: string;
  error?: string;
}

/**
 * Get Order Book Summary Action for Polymarket.
 * Retrieves a summary of the order book for a specific token.
 */
export const getOrderBookSummaryAction: Action = {
  name: "POLYMARKET_GET_ORDER_BOOK_SUMMARY",
  similes: ["ORDER_BOOK_OVERVIEW", "BOOK_SUMMARY", "MARKET_DEPTH_SUMMARY"].map(
    (s) => `POLYMARKET_${s}`
  ),
  description:
    "Retrieves a summary of the order book for a specific token ID on Polymarket, including best bid/ask and spread.",

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    logger.info(
      `[getOrderBookSummaryAction] Validate called for message: "${message.content?.text}"`
    );
    const clobApiUrl = runtime.getSetting("CLOB_API_URL");

    if (!clobApiUrl) {
      logger.warn("[getOrderBookSummaryAction] CLOB_API_URL is required.");
      return false;
    }
    logger.info("[getOrderBookSummaryAction] Validation passed");
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    logger.info("[getOrderBookSummaryAction] Handler called!");

    const result = await callLLMWithTimeout<LLMOrderBookSummaryResult>(
      runtime,
      state,
      getOrderBookTemplate,
      "getOrderBookSummaryAction"
    );
    let llmResult: LLMOrderBookSummaryResult = {};
    if (result && !isLLMError(result)) {
      llmResult = result;
    }
    logger.info(`[getOrderBookSummaryAction] LLM result: ${JSON.stringify(llmResult)}`);

    if (llmResult.error || !llmResult.tokenId) {
      const errorMsg = llmResult.error || "Token ID not found in LLM result.";
      return {
        success: false,
        text: errorMsg,
        error: errorMsg,
      };
    }

    const tokenId = llmResult.tokenId;

    logger.info(`[getOrderBookSummaryAction] Fetching order book summary for token: ${tokenId}`);

    const client = (await initializeClobClient(runtime)) as ClobClient;
    // Use getOrderBook instead of getOrderBookSummary which doesn't exist
    const summary: OrderBookSummary = await client.getOrderBook(tokenId);

    let responseText = `📊 **Order Book Summary for Token ${tokenId}**:\n\n`;

    if (summary) {
      // OrderBookSummary has bids and asks arrays, not bid/ask/spread properties
      const bestBid = summary.bids && summary.bids.length > 0 ? summary.bids[0] : null;
      const bestAsk = summary.asks && summary.asks.length > 0 ? summary.asks[0] : null;

      responseText += `• **Best Bid**: ${bestBid ? `$${parseFloat(bestBid.price).toFixed(4)} (size: ${bestBid.size})` : "N/A"}\n`;
      responseText += `• **Best Ask**: ${bestAsk ? `$${parseFloat(bestAsk.price).toFixed(4)} (size: ${bestAsk.size})` : "N/A"}\n`;

      if (bestBid && bestAsk) {
        const bidPrice = parseFloat(bestBid.price);
        const askPrice = parseFloat(bestAsk.price);
        const spread = askPrice - bidPrice;
        const midpoint = (bidPrice + askPrice) / 2;
        responseText += `• **Spread**: $${spread.toFixed(4)}\n`;
        responseText += `• **Midpoint**: $${midpoint.toFixed(4)}\n`;
      }

      responseText += `• **Total Bid Levels**: ${summary.bids?.length || 0}\n`;
      responseText += `• **Total Ask Levels**: ${summary.asks?.length || 0}\n`;
    } else {
      responseText += `Could not retrieve order book summary. The order book may be empty.\n`;
    }

    const responseContent: Content = {
      text: responseText,
      actions: ["GET_ORDER_BOOK_SUMMARY"],
      data: {
        tokenId,
        bidLevels: summary?.bids?.length || 0,
        askLevels: summary?.asks?.length || 0,
        timestamp: new Date().toISOString(),
      },
    };

    if (callback) await callback(responseContent);
    return {
      success: true,
      text: responseText,
      data: {
        tokenId,
        bidLevels: summary?.bids?.length || 0,
        askLevels: summary?.asks?.length || 0,
        timestamp: new Date().toISOString(),
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Give me the order book summary for token xyz123 on Polymarket.",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Fetching order book summary for token xyz123 on Polymarket...",
          action: "POLYMARKET_GET_ORDER_BOOK_SUMMARY",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "What is the spread for token 0xabc789 via Polymarket?",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Looking up the order book summary for token 0xabc789 on Polymarket...",
          action: "POLYMARKET_GET_ORDER_BOOK_SUMMARY",
        },
      },
    ],
  ],
};
