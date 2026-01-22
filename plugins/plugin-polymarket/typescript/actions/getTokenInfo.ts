/**
 * @elizaos/plugin-polymarket Get Token Info Action
 *
 * Consolidated action for retrieving comprehensive information about a single token.
 * Combines market details, current pricing, price history, and user-specific data.
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
import type { ClobClient } from "@polymarket/clob-client";
import { POLYMARKET_SERVICE_NAME } from "../constants";
import type { PolymarketService } from "../services/polymarket";
import type { Market, OpenOrder, OrderBook, Position } from "../types";
import { initializeClobClient } from "../utils/clobClient";
import {
  callLLMWithTimeout,
  isLLMError,
  sendAcknowledgement,
  sendError,
} from "../utils/llmHelpers";

// =============================================================================
// Types
// =============================================================================

interface LLMTokenInfoResult {
  tokenId?: string;
  conditionId?: string;
  error?: string;
}

interface PriceHistoryPoint {
  t: number;
  p: number | string;
}

interface TokenPricing {
  bestBid: string | null;
  bestBidSize: string | null;
  bestAsk: string | null;
  bestAskSize: string | null;
  midpoint: string | null;
  spread: string | null;
  bidLevels: number;
  askLevels: number;
}

interface PriceHistorySummary {
  open: string;
  high: string;
  low: string;
  close: string;
  change: string;
  changePercent: string;
  dataPoints: number;
  periodHours: number;
}

interface TokenInfo {
  tokenId: string;
  outcome: string;
  market: {
    conditionId: string;
    question: string;
    tags: string[];
    active: boolean;
    closed: boolean;
    endDate: string | null;
    minOrderSize: string;
    minTickSize: string;
  };
  pricing: TokenPricing;
  priceHistory24h: PriceHistorySummary | null;
  userPosition: Position | null;
  userOrders: OpenOrder[];
}

// =============================================================================
// Helper Functions
// =============================================================================

function safeNumber(input: string | number | undefined): number {
  if (typeof input === "number") {
    return Number.isFinite(input) ? input : 0;
  }
  if (typeof input === "string") {
    const parsed = Number.parseFloat(input);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function calculatePricing(orderBook: OrderBook): TokenPricing {
  const topBid = orderBook.bids?.[0];
  const topAsk = orderBook.asks?.[0];

  const bestBid = topBid?.price ?? null;
  const bestBidSize = topBid?.size ?? null;
  const bestAsk = topAsk?.price ?? null;
  const bestAskSize = topAsk?.size ?? null;

  let midpoint: string | null = null;
  let spread: string | null = null;

  if (bestBid && bestAsk) {
    const bidNum = safeNumber(bestBid);
    const askNum = safeNumber(bestAsk);
    midpoint = ((bidNum + askNum) / 2).toFixed(4);
    spread = (askNum - bidNum).toFixed(4);
  }

  return {
    bestBid,
    bestBidSize,
    bestAsk,
    bestAskSize,
    midpoint,
    spread,
    bidLevels: orderBook.bids?.length ?? 0,
    askLevels: orderBook.asks?.length ?? 0,
  };
}

function calculatePriceHistorySummary(
  priceHistory: PriceHistoryPoint[],
  periodHours: number,
): PriceHistorySummary | null {
  if (!priceHistory || priceHistory.length === 0) {
    return null;
  }

  const prices = priceHistory.map((p) => safeNumber(p.p));
  const open = prices[0];
  const close = prices[prices.length - 1];
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const change = close - open;
  const changePercent = open !== 0 ? (change / open) * 100 : 0;

  return {
    open: open.toFixed(4),
    high: high.toFixed(4),
    low: low.toFixed(4),
    close: close.toFixed(4),
    change: change.toFixed(4),
    changePercent: changePercent.toFixed(2),
    dataPoints: priceHistory.length,
    periodHours,
  };
}

function formatTokenInfo(tokenInfo: TokenInfo): string {
  const lines: string[] = [];

  // Header
  lines.push(`📊 **Token Info: ${tokenInfo.outcome}**`);
  lines.push("");

  // Market Details
  lines.push(`**Market:** ${tokenInfo.market.question}`);
  const tagsDisplay = tokenInfo.market.tags?.length > 0 ? tokenInfo.market.tags.join(", ") : "N/A";
  lines.push(`• Tags: ${tagsDisplay}`);
  lines.push(
    `• Status: ${tokenInfo.market.active ? "Active" : "Inactive"}, ${tokenInfo.market.closed ? "Closed" : "Open"}`,
  );
  if (tokenInfo.market.endDate) {
    lines.push(`• End Date: ${new Date(tokenInfo.market.endDate).toLocaleDateString()}`);
  }
  lines.push(`• Token ID: \`${tokenInfo.tokenId}\``);
  lines.push("");

  // Current Pricing
  lines.push("**Current Pricing:**");
  if (tokenInfo.pricing.bestBid || tokenInfo.pricing.bestAsk) {
    if (tokenInfo.pricing.bestBid) {
      lines.push(
        `• Best Bid: $${tokenInfo.pricing.bestBid} (${tokenInfo.pricing.bestBidSize} shares)`,
      );
    }
    if (tokenInfo.pricing.bestAsk) {
      lines.push(
        `• Best Ask: $${tokenInfo.pricing.bestAsk} (${tokenInfo.pricing.bestAskSize} shares)`,
      );
    }
    if (tokenInfo.pricing.midpoint) {
      lines.push(`• Midpoint: $${tokenInfo.pricing.midpoint}`);
    }
    if (tokenInfo.pricing.spread) {
      lines.push(`• Spread: $${tokenInfo.pricing.spread}`);
    }
    lines.push(
      `• Order Book Depth: ${tokenInfo.pricing.bidLevels} bids, ${tokenInfo.pricing.askLevels} asks`,
    );
  } else {
    lines.push("• No order book data available");
  }
  lines.push("");

  // Price History
  if (tokenInfo.priceHistory24h) {
    const ph = tokenInfo.priceHistory24h;
    const changeEmoji = safeNumber(ph.change) >= 0 ? "📈" : "📉";
    const changeSign = safeNumber(ph.change) >= 0 ? "+" : "";
    lines.push(`**24h Price Summary:** ${changeEmoji}`);
    lines.push(`• Open: $${ph.open} → Close: $${ph.close}`);
    lines.push(`• High: $${ph.high} / Low: $${ph.low}`);
    lines.push(`• Change: ${changeSign}$${ph.change} (${changeSign}${ph.changePercent}%)`);
    lines.push("");
  }

  // User Position
  if (tokenInfo.userPosition) {
    const pos = tokenInfo.userPosition;
    const pnl = safeNumber(pos.realized_pnl);
    const pnlSign = pnl >= 0 ? "+" : "";
    lines.push("**Your Position:**");
    lines.push(`• Size: ${pos.size} shares`);
    lines.push(`• Avg Price: $${pos.average_price}`);
    lines.push(`• Realized PnL: ${pnlSign}$${pos.realized_pnl}`);
    lines.push("");
  }

  // User Orders
  if (tokenInfo.userOrders.length > 0) {
    lines.push(`**Your Active Orders:** (${tokenInfo.userOrders.length})`);
    tokenInfo.userOrders.slice(0, 5).forEach((order) => {
      const sideEmoji = order.side === "BUY" ? "🟢" : "🔴";
      lines.push(
        `${sideEmoji} ${order.side} ${order.original_size} @ $${parseFloat(order.price).toFixed(4)} (${order.status})`,
      );
    });
    if (tokenInfo.userOrders.length > 5) {
      lines.push(`  ... and ${tokenInfo.userOrders.length - 5} more orders`);
    }
  }

  return lines.join("\n");
}

// =============================================================================
// Template for LLM extraction
// =============================================================================

const getTokenInfoTemplate = `You are an assistant extracting token/market identifiers from user messages for Polymarket queries.

The user wants information about a specific token or market. Extract:
- tokenId: The token ID (condition token ID, a hex string like 0x...)
- conditionId: The market condition ID if provided instead of token ID

If the user provides a market name or question instead of an ID, set error to indicate we need to look it up.

Respond with JSON only:
{
  "tokenId": "string or null",
  "conditionId": "string or null",
  "error": "string or null"
}

Recent conversation:
{{recentMessages}}

User's current request:
{{currentMessage}}`;

// =============================================================================
// Action Definition
// =============================================================================

export const getTokenInfoAction: Action = {
  name: "POLYMARKET_GET_TOKEN_INFO",
  similes: [
    "TOKEN_INFO",
    "TOKEN_DETAILS",
    "MARKET_INFO",
    "SHOW_TOKEN",
    "ABOUT_TOKEN",
    "TOKEN_SUMMARY",
    "PRICE_INFO",
    "MARKET_SUMMARY",
  ],
  description:
    "Retrieves comprehensive information about a single Polymarket token including market details (question, status, end date), current pricing (bid/ask, spread, midpoint), 24h price history (OHLC, change %), and user's position and active orders for that token. Parameters: tokenId (condition token ID) or conditionId (market condition ID).",

  parameters: [
    {
      name: "tokenId",
      description: "Polymarket condition token ID to get info for",
      required: false,
      schema: { type: "string" },
      examples: ["0x123...", "71321..."],
    },
    {
      name: "conditionId",
      description: "Market condition ID (alternative to tokenId)",
      required: false,
      schema: { type: "string" },
      examples: ["0xabc..."],
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
    runtime.logger.info("[getTokenInfoAction] Handler called");

    // Extract token/condition ID from parameters or LLM
    let tokenId: string | null = null;
    let conditionId: string | null = null;

    const params = options?.parameters as Record<string, string> | undefined;
    if (params?.tokenId) {
      tokenId = params.tokenId;
    } else if (params?.conditionId) {
      conditionId = params.conditionId;
    } else {
      // Try LLM extraction
      const llmResult = await callLLMWithTimeout<LLMTokenInfoResult>(
        runtime,
        state,
        getTokenInfoTemplate,
        "getTokenInfoAction",
      );

      if (!isLLMError(llmResult)) {
        tokenId = llmResult?.tokenId ?? null;
        conditionId = llmResult?.conditionId ?? null;
      }
    }

    if (!tokenId && !conditionId) {
      await sendError(callback, "Please provide a token ID or market condition ID.");
      return { success: false, text: "Missing token or condition ID", error: "missing_id" };
    }

    // Send acknowledgement before API calls
    const idDisplay = tokenId
      ? `token ${tokenId.slice(0, 16)}...`
      : `condition ${conditionId?.slice(0, 16)}...`;
    await sendAcknowledgement(callback, `Fetching info for ${idDisplay}`, {
      tokenId: tokenId ? `${tokenId.slice(0, 20)}...` : undefined,
      conditionId: conditionId ? `${conditionId.slice(0, 20)}...` : undefined,
    });

    try {
      const client = (await initializeClobClient(runtime)) as ClobClient;
      const service = runtime.getService(POLYMARKET_SERVICE_NAME) as PolymarketService | undefined;

      // If we have conditionId but not tokenId, get market first to find tokens
      let market: Market | null = null;
      if (conditionId) {
        market = (await client.getMarket(conditionId)) as Market;
        if (market?.tokens?.[0]) {
          tokenId = market.tokens[0].token_id;
        }
      }

      if (!tokenId) {
        throw new Error("Could not determine token ID from provided parameters.");
      }

      // Fetch order book first to validate token exists
      let orderBook: OrderBook;
      try {
        orderBook = (await client.getOrderBook(tokenId)) as OrderBook;
      } catch (err) {
        runtime.logger.error(
          `[getTokenInfoAction] Failed to fetch order book for token ${tokenId.slice(0, 20)}...`,
          err,
        );
        throw new Error(`Token not found or invalid. Please check the token ID and try again.`);
      }

      // Check if token has any liquidity - if not, it might be invalid
      const hasLiquidity = (orderBook.bids?.length ?? 0) > 0 || (orderBook.asks?.length ?? 0) > 0;
      if (!hasLiquidity && !orderBook.market) {
        runtime.logger.warn(
          `[getTokenInfoAction] Token ${tokenId.slice(0, 20)}... has no order book data and no market reference`,
        );
        // Don't throw - continue but warn the user in the response
      }

      // Fetch market details if we don't have them yet
      if (!market && orderBook.market) {
        try {
          market = (await client.getMarket(orderBook.market)) as Market;
        } catch (err) {
          runtime.logger.warn(
            `[getTokenInfoAction] Failed to fetch market for ${orderBook.market}:`,
            err,
          );
        }
      }

      const pricing = calculatePricing(orderBook);

      // Fetch 24h price history
      const now = Math.floor(Date.now() / 1000);
      const oneDayAgo = now - 86400;
      let priceHistory24h: PriceHistorySummary | null = null;

      try {
        const priceHistoryResponse = await client.getPricesHistory({
          market: tokenId,
          startTs: oneDayAgo,
          endTs: now,
          fidelity: 60, // Hourly data points
        });
        // Map the API response to our PriceHistoryPoint type to ensure proper typing
        const priceHistoryData: PriceHistoryPoint[] = Array.isArray(priceHistoryResponse)
          ? priceHistoryResponse.map((item: { t: number; p: number | string }) => ({
              t: typeof item.t === "number" ? item.t : Number(item.t),
              p: typeof item.p === "number" ? item.p : Number(item.p),
            }))
          : [];
        priceHistory24h = calculatePriceHistorySummary(priceHistoryData, 24);
      } catch (err) {
        runtime.logger.warn("[getTokenInfoAction] Failed to fetch price history:", err);
      }

      // Get user position and orders from cached account state
      let userPosition: Position | null = null;
      let userOrders: OpenOrder[] = [];

      if (service) {
        const accountState = await service.getAccountState();
        if (accountState) {
          userPosition = accountState.positions.find((p) => p.asset_id === tokenId) ?? null;
          userOrders = accountState.activeOrders.filter((o) => o.asset_id === tokenId);
        }
      }

      // Determine outcome name from market tokens
      let outcome = "Unknown";
      if (market?.tokens) {
        const matchingToken = market.tokens.find((t) => t.token_id === tokenId);
        if (matchingToken) {
          outcome = matchingToken.outcome;
        }
      }

      const tokenInfo: TokenInfo = {
        tokenId,
        outcome,
        market: {
          conditionId: market?.condition_id ?? conditionId ?? "",
          question: market?.question ?? "Unknown Market",
          tags: market?.tags ?? [],
          active: market?.active ?? false,
          closed: market?.closed ?? false,
          endDate: market?.end_date_iso ?? null,
          minOrderSize: market?.minimum_order_size ?? "0",
          minTickSize: market?.minimum_tick_size ?? "0",
        },
        pricing,
        priceHistory24h,
        userPosition,
        userOrders,
      };

      const responseText = formatTokenInfo(tokenInfo);

      const responseData = {
        tokenId,
        conditionId: tokenInfo.market.conditionId,
        outcome,
        question: tokenInfo.market.question,
        midpoint: pricing.midpoint,
        change24h: priceHistory24h?.changePercent ?? null,
        hasPosition: userPosition !== null,
        activeOrdersCount: userOrders.length,
        timestamp: new Date().toISOString(),
      };

      const responseContent: Content = {
        text: responseText,
        actions: ["POLYMARKET_GET_TOKEN_INFO"],
        data: responseData,
      };

      if (callback) await callback(responseContent);

      // Record activity if service is available
      if (service) {
        await service.recordActivity({
          type: "market_details",
          conditionId: tokenInfo.market.conditionId,
          question: tokenInfo.market.question,
          tags: tokenInfo.market.tags,
          active: tokenInfo.market.active,
          closed: tokenInfo.market.closed,
          tokens: market?.tokens?.map((t) => ({
            tokenId: t.token_id,
            outcome: t.outcome,
          })),
        });
      }

      return {
        success: true,
        text: responseText,
        data: responseData as Record<string, unknown>,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error occurred";
      runtime.logger.error("[getTokenInfoAction] Error:", error);

      const errorContent: Content = {
        text: `❌ **Error fetching token info**: ${errorMsg}`,
        actions: ["POLYMARKET_GET_TOKEN_INFO"],
      };

      if (callback) await callback(errorContent);
      return { success: false, text: errorMsg, error: errorMsg };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Tell me about token 0x123abc..." },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll get comprehensive info for that token.",
          action: "POLYMARKET_GET_TOKEN_INFO",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "What's the current state of the Bitcoin market?" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll look up the token info for that market.",
          action: "POLYMARKET_GET_TOKEN_INFO",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Show me everything about this token including my position" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Fetching complete token info including your position and orders.",
          action: "POLYMARKET_GET_TOKEN_INFO",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Find me some good markets to trade" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "That's a discovery request. I'll use the markets listing action instead to help you browse available markets.",
        },
      },
    ],
  ],
};
