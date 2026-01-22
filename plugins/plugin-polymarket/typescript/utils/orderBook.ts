/**
 * Order Book Utility Functions
 *
 * Provides helpers for parsing, normalizing, and fetching order book data
 * from the Polymarket CLOB API.
 */

import type { IAgentRuntime, State } from "@elizaos/core";
import type { OrderBookSummary } from "@polymarket/clob-client";
import { initializeClobClient } from "./clobClient";
import { callLLMWithTimeout, isLLMError } from "./llmHelpers";

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * Response structure from LLM when extracting a single token ID.
 */
export interface LLMTokenResult {
  tokenId?: string;
  error?: string;
}

/**
 * Response structure from LLM when extracting multiple token IDs.
 */
export interface LLMTokensResult {
  tokenIds?: string[];
  error?: string;
}

/**
 * Supported order book metrics:
 * - "summary": Full order book snapshot with top bids/asks, spread, midpoint
 * - "bestPrice": Top-of-book price for a given side
 * - "midpoint": Midpoint between best bid and best ask
 * - "spread": Difference between best ask and best bid
 */
export type OrderBookMetric = "summary" | "bestPrice" | "midpoint" | "spread";

/**
 * Order book side identifiers:
 * - "buy" / "ask": The price at which you can buy (lowest ask)
 * - "sell" / "bid": The price at which you can sell (highest bid)
 */
export type BestPriceSide = "buy" | "sell" | "bid" | "ask";

/**
 * Options for order book queries parsed from action parameters.
 */
export interface OrderBookOptions {
  metric?: OrderBookMetric;
  side?: BestPriceSide;
  tokenId?: string;
  tokenIds?: string[];
}

// =============================================================================
// Parameter Parsing
// =============================================================================

/**
 * Parses action parameters into strongly-typed order book options.
 *
 * @param parameters - Raw action parameters object
 * @returns Parsed OrderBookOptions with validated fields
 */
export function parseOrderBookParameters(parameters?: Record<string, unknown>): OrderBookOptions {
  if (!parameters) {
    return {};
  }
  const metric = typeof parameters.metric === "string" ? normalizeMetric(parameters.metric) : null;
  const side = typeof parameters.side === "string" ? normalizeSide(parameters.side) : null;
  const tokenId = typeof parameters.tokenId === "string" ? parameters.tokenId : undefined;
  const tokenIds = Array.isArray(parameters.tokenIds)
    ? parameters.tokenIds.filter((value) => typeof value === "string")
    : undefined;

  return {
    metric: metric ?? undefined,
    side: side ?? undefined,
    tokenId,
    tokenIds,
  };
}

// =============================================================================
// Metric Normalization
// =============================================================================

/**
 * Normalizes a metric string to a valid OrderBookMetric enum value.
 *
 * @param metric - Raw metric string from user input
 * @returns Normalized OrderBookMetric or null if invalid
 *
 * @example
 * normalizeMetric("best_price") // returns "bestPrice"
 * normalizeMetric("SPREAD")     // returns "spread"
 * normalizeMetric("invalid")    // returns null
 */
export function normalizeMetric(metric?: string): OrderBookMetric | null {
  if (!metric) {
    return null;
  }
  const normalized = metric.trim().toLowerCase();
  if (normalized === "summary") {
    return "summary";
  }
  if (normalized === "bestprice" || normalized === "best_price" || normalized === "best price") {
    return "bestPrice";
  }
  if (normalized === "midpoint" || normalized === "mid") {
    return "midpoint";
  }
  if (normalized === "spread") {
    return "spread";
  }
  return null;
}

/**
 * Infers the intended metric from natural language text.
 * Falls back to "summary" if no specific metric is detected.
 *
 * @param text - Natural language query text
 * @returns Inferred OrderBookMetric
 *
 * @example
 * inferMetricFromText("what's the spread?")      // returns "spread"
 * inferMetricFromText("show me the order book")  // returns "summary"
 */
export function inferMetricFromText(text?: string): OrderBookMetric {
  if (!text) {
    return "summary";
  }
  const normalized = text.toLowerCase();
  if (normalized.includes("spread")) {
    return "spread";
  }
  if (normalized.includes("midpoint") || normalized.includes("midpoint price")) {
    return "midpoint";
  }
  if (
    normalized.includes("best price") ||
    normalized.includes("best bid") ||
    normalized.includes("best ask")
  ) {
    return "bestPrice";
  }
  if (normalized.includes("bid price") || normalized.includes("ask price")) {
    return "bestPrice";
  }
  return "summary";
}

// =============================================================================
// Side Normalization
// =============================================================================

/**
 * Normalizes a side string to a valid BestPriceSide enum value.
 *
 * @param side - Raw side string from user input
 * @returns Normalized BestPriceSide or null if invalid
 *
 * @example
 * normalizeSide("BUY")  // returns "buy"
 * normalizeSide("Ask")  // returns "ask"
 */
export function normalizeSide(side?: string): BestPriceSide | null {
  if (!side) {
    return null;
  }
  const normalized = side.trim().toLowerCase();
  if (
    normalized === "buy" ||
    normalized === "sell" ||
    normalized === "bid" ||
    normalized === "ask"
  ) {
    return normalized;
  }
  return null;
}

/**
 * Infers the intended side from natural language text.
 * Falls back to "buy" if no specific side is detected.
 *
 * @param text - Natural language query text
 * @returns Inferred BestPriceSide
 *
 * @example
 * inferSideFromText("what's the best bid?")  // returns "sell" (bid = sell side)
 * inferSideFromText("show ask price")        // returns "buy" (ask = buy side)
 */
export function inferSideFromText(text?: string): BestPriceSide {
  if (!text) {
    return "buy";
  }
  const normalized = text.toLowerCase();
  if (normalized.includes("bid") || normalized.includes("sell")) {
    return "sell";
  }
  if (normalized.includes("ask") || normalized.includes("buy")) {
    return "buy";
  }
  return "buy";
}

// =============================================================================
// LLM Token Resolution
// =============================================================================

/**
 * Resolves a token ID from conversation context using LLM extraction.
 *
 * Use this when the token ID is not explicitly provided in action parameters
 * and needs to be inferred from the user's message or conversation state.
 *
 * @param runtime - Agent runtime for LLM access
 * @param state - Current conversation state
 * @param template - Prompt template for token extraction
 * @param actionName - Name of the calling action (for logging)
 * @returns LLMTokenResult with tokenId or error
 */
export async function resolveTokenIdFromLLM(
  runtime: IAgentRuntime,
  state: State | undefined,
  template: string,
  actionName: string,
): Promise<LLMTokenResult> {
  const result = await callLLMWithTimeout<LLMTokenResult>(runtime, state, template, actionName);
  const llmResult = result && !isLLMError(result) ? result : {};
  runtime.logger.info(`[${actionName}] LLM result: ${JSON.stringify(llmResult)}`);
  return llmResult;
}

// =============================================================================
// Order Book Fetching
// =============================================================================

/**
 * Fetches the order book summary for a single token from the CLOB API.
 *
 * @param runtime - Agent runtime for client initialization
 * @param tokenId - Polymarket condition token ID
 * @returns OrderBookSummary with bids and asks
 *
 * @example
 * const orderBook = await fetchOrderBookSummary(runtime, "12345...");
 * console.log(orderBook.bids[0].price); // Best bid price
 */
export async function fetchOrderBookSummary(
  runtime: IAgentRuntime,
  tokenId: string,
): Promise<OrderBookSummary> {
  const client = await initializeClobClient(runtime);
  return client.getOrderBook(tokenId);
}
