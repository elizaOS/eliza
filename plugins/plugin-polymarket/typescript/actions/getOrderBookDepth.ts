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
import { getOrderBookDepthTemplate } from "../templates";
import { initializeClobClient } from "../utils/clobClient";
import { callLLMWithTimeout, isLLMError } from "../utils/llmHelpers";

interface LLMOrderBookDepthResult {
  tokenId?: string;
  error?: string;
}

/**
 * Get Order Book Depth Action for Polymarket.
 * Retrieves the order book depth (all bids and asks) for a specific token.
 */
export const getOrderBookDepthAction: Action = {
  name: "POLYMARKET_GET_ORDER_BOOK_DEPTH",
  similes: ["FULL_ORDER_BOOK", "ORDER_DEPTH", "ALL_ORDERS", "DEPTH_OF_MARKET"].map(
    (s) => `POLYMARKET_${s}`
  ),
  description:
    "Retrieves the full order book depth (all bids and asks) for a specific token ID on Polymarket.",

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    logger.info(
      `[getOrderBookDepthAction] Validate called for message: "${message.content?.text}"`
    );
    const clobApiUrl = runtime.getSetting("CLOB_API_URL");

    if (!clobApiUrl) {
      logger.warn("[getOrderBookDepthAction] CLOB_API_URL is required.");
      return false;
    }
    logger.info("[getOrderBookDepthAction] Validation passed");
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    logger.info("[getOrderBookDepthAction] Handler called!");

    const result = await callLLMWithTimeout<LLMOrderBookDepthResult>(
      runtime,
      state,
      getOrderBookDepthTemplate,
      "getOrderBookDepthAction"
    );
    let llmResult: LLMOrderBookDepthResult = {};
    if (result && !isLLMError(result)) {
      llmResult = result;
    }
    logger.info(`[getOrderBookDepthAction] LLM result: ${JSON.stringify(llmResult)}`);

    if (llmResult.error || !llmResult.tokenId) {
      const errorMsg = llmResult.error || "Token ID not found in LLM result.";
      return {
        success: false,
        text: errorMsg,
        error: errorMsg,
      };
    }

    const tokenId = llmResult.tokenId;

    logger.info(`[getOrderBookDepthAction] Fetching order book depth for token: ${tokenId}`);

    const client = (await initializeClobClient(runtime)) as ClobClient;
    // Use OrderBookSummary type from clob-client (getOrderBook returns this)
    const depth: OrderBookSummary = await client.getOrderBook(tokenId);

    let responseText = `📊 **Order Book Depth for Token ${tokenId}**:\n\n`;

    const bids = depth?.bids || [];
    const asks = depth?.asks || [];

    responseText += `**Bids (Buy Orders):** ${bids.length}\n`;
    if (bids.length > 0) {
      const topBids = bids.slice(0, 5);
      topBids.forEach((bid, index: number) => {
        responseText += `  ${index + 1}. $${parseFloat(bid.price).toFixed(4)} × ${bid.size}\n`;
      });
      if (bids.length > 5) {
        responseText += `  ... and ${bids.length - 5} more bids\n`;
      }
    } else {
      responseText += `  No bids currently.\n`;
    }

    responseText += `\n**Asks (Sell Orders):** ${asks.length}\n`;
    if (asks.length > 0) {
      const topAsks = asks.slice(0, 5);
      topAsks.forEach((ask, index: number) => {
        responseText += `  ${index + 1}. $${parseFloat(ask.price).toFixed(4)} × ${ask.size}\n`;
      });
      if (asks.length > 5) {
        responseText += `  ... and ${asks.length - 5} more asks\n`;
      }
    } else {
      responseText += `  No asks currently.\n`;
    }

    // Calculate spread if we have both bids and asks
    if (bids.length > 0 && asks.length > 0) {
      const bestBid = parseFloat(bids[0].price);
      const bestAsk = parseFloat(asks[0].price);
      const spread = bestAsk - bestBid;
      const spreadPercent = ((spread / bestAsk) * 100).toFixed(2);
      responseText += `\n**Spread:** $${spread.toFixed(4)} (${spreadPercent}%)\n`;
    }

    const responseContent: Content = {
      text: responseText,
      actions: ["GET_ORDER_BOOK_DEPTH"],
      data: {
        tokenId,
        totalBids: bids.length,
        totalAsks: asks.length,
        timestamp: new Date().toISOString(),
      },
    };

    if (callback) await callback(responseContent);
    return {
      success: true,
      text: responseText,
      data: {
        tokenId,
        totalBids: bids.length,
        totalAsks: asks.length,
        timestamp: new Date().toISOString(),
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Show me the order book depth for token xyz123 on Polymarket.",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Fetching order book depth for token xyz123 on Polymarket...",
          action: "POLYMARKET_GET_ORDER_BOOK_DEPTH",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "What are all the bids and asks for token 0xabc789 via Polymarket?",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Looking up the full order book for token 0xabc789 on Polymarket...",
          action: "POLYMARKET_GET_ORDER_BOOK_DEPTH",
        },
      },
    ],
  ],
};
