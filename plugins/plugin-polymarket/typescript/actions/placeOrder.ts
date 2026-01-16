import type {
  Action,
  ActionResult,
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  type ClobClient,
  OrderType as ClobOrderType,
  Side,
  type UserOrder,
} from "@polymarket/clob-client";
import {
  GAMMA_API_URL,
  POLYMARKET_PROVIDER_CACHE_KEY,
  POLYMARKET_SERVICE_NAME,
} from "../constants";
import type { PolymarketService } from "../services/polymarket";
import { orderTemplate } from "../templates";
import type { OrderResponse } from "../types";
import { initializeClobClient, initializeClobClientWithCreds } from "../utils/clobClient";
import {
  callLLMWithTimeout,
  isLLMError,
  sendAcknowledgement,
  sendError,
  sendUpdate,
} from "../utils/llmHelpers";

interface PlaceOrderParams {
  tokenId?: string;
  side: string;
  price: number;
  size?: number; // Deprecated - use dollarAmount or shares
  dollarAmount?: number; // Dollar amount to spend (e.g., $5)
  shares?: number; // Number of shares to buy/sell
  orderType?: string;
  feeRateBps?: string;
  marketName?: string;
  outcome?: string; // "yes" or "no" - which outcome to bet on
  error?: string;
}

interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  outcomes: string;
  outcomePrices: string;
  volume: string;
  active: boolean;
  closed: boolean;
  clobTokenIds?: string;
  groupItemTitle?: string;
}

interface GammaEvent {
  id: string;
  title: string;
  markets?: GammaMarket[];
}

interface GammaSearchResponse {
  events: GammaEvent[];
}

interface MarketCandidate {
  question: string;
  eventTitle?: string;
  tokenIds: string[];
  outcomes: string[];
  prices: number[];
  volume: number;
}

interface SearchMarketResult {
  match?: { tokenId: string; question: string; price: number };
  candidates?: MarketCandidate[];
}

/**
 * Search for a market by name and return matching token info
 * Handles both direct market searches ("Miami Heat playoffs") and
 * event+market searches ("Where will Giannis be traded? Miami Heat")
 */
async function searchMarketByName(
  runtime: IAgentRuntime,
  marketName: string,
  outcome?: string,
): Promise<SearchMarketResult> {
  const params = new URLSearchParams({
    q: marketName,
    limit_per_type: "20",
    events_status: "active",
  });

  const url = `${GAMMA_API_URL}/public-search?${params.toString()}`;
  runtime.logger.info(`[placeOrder] Searching for market: ${marketName}`);

  try {
    const response = await runtime.fetch(url);
    if (!response.ok) {
      runtime.logger.error(`[placeOrder] Market search failed: ${response.status}`);
      return { candidates: [] };
    }

    const data = (await response.json()) as GammaSearchResponse;
    const events = data.events || [];

    if (events.length === 0) {
      runtime.logger.warn(`[placeOrder] No events found for: ${marketName}`);
      return { candidates: [] };
    }

    const normalizedSearch = marketName.toLowerCase().trim();
    const searchWords = normalizedSearch.split(/\s+/).filter((w) => w.length > 2);

    // Strategy 1: Find event whose title matches, then find market within it
    for (const event of events) {
      if (!event.markets || event.markets.length === 0) continue;

      const eventTitle = (event.title || "").toLowerCase();
      const eventTitleWords = eventTitle.split(/\s+/).filter((w) => w.length > 2);

      // Words from search that match the event title
      const eventMatchWords = searchWords.filter((sw) =>
        eventTitleWords.some((tw) => tw.includes(sw) || sw.includes(tw)),
      );

      // Words from search that DON'T match event title (market-specific)
      const marketSpecificWords = searchWords.filter(
        (sw) => !eventTitleWords.some((tw) => tw.includes(sw) || sw.includes(tw)),
      );

      runtime.logger.info(
        `[placeOrder] Event "${event.title}": eventMatch=[${eventMatchWords.join(",")}], marketSpecific=[${marketSpecificWords.join(",")}]`,
      );

      // If we have market-specific words, find matching market in this event
      if (marketSpecificWords.length > 0 && eventMatchWords.length > 0) {
        for (const market of event.markets) {
          if (!market.active || market.closed) continue;

          const question = (market.question || "").toLowerCase();
          const groupTitle = (market.groupItemTitle || "").toLowerCase();

          // Check if market-specific words match this market
          const marketMatches = marketSpecificWords.some(
            (word) => question.includes(word) || groupTitle.includes(word),
          );

          if (marketMatches && market.clobTokenIds) {
            return { match: extractTokenFromMarket(market, outcome, runtime) ?? undefined };
          }
        }
      }
    }

    // Strategy 2: Direct market match - all words must match
    for (const event of events) {
      if (!event.markets) continue;

      for (const market of event.markets) {
        if (!market.active || market.closed) continue;

        const question = (market.question || "").toLowerCase();
        const groupTitle = (market.groupItemTitle || "").toLowerCase();

        // Check if all search words match
        const allMatch = searchWords.every(
          (word) => question.includes(word) || groupTitle.includes(word),
        );

        if (allMatch && market.clobTokenIds) {
          return { match: extractTokenFromMarket(market, outcome, runtime) ?? undefined };
        }
      }
    }

    // Strategy 3: Partial match - most words match
    let bestMatch: GammaMarket | null = null;
    let bestScore = 0;

    for (const event of events) {
      if (!event.markets) continue;

      for (const market of event.markets) {
        if (!market.active || market.closed || !market.clobTokenIds) continue;

        const question = (market.question || "").toLowerCase();
        const groupTitle = (market.groupItemTitle || "").toLowerCase();

        const matchCount = searchWords.filter(
          (word) => question.includes(word) || groupTitle.includes(word),
        ).length;

        if (matchCount > bestScore) {
          bestScore = matchCount;
          bestMatch = market;
        }
      }
    }

    if (bestMatch && bestScore >= Math.ceil(searchWords.length * 0.5)) {
      runtime.logger.info(
        `[placeOrder] Best partial match (${bestScore}/${searchWords.length}): ${bestMatch.question}`,
      );
      return { match: extractTokenFromMarket(bestMatch, outcome, runtime) ?? undefined };
    }

    return { candidates: buildCandidates(events) };
  } catch (error) {
    runtime.logger.error(`[placeOrder] Market search error:`, error);
    return { candidates: [] };
  }
}

function extractTokenFromMarket(
  market: GammaMarket,
  outcome: string | undefined,
  runtime: IAgentRuntime,
): { tokenId: string; question: string; price: number } | null {
  try {
    const tokenIds = JSON.parse(market.clobTokenIds!) as string[];
    const pricesStr = JSON.parse(market.outcomePrices) as string[];
    const prices = pricesStr.map((p) => parseFloat(p));

    if (tokenIds.length === 0) return null;

    // Determine which token to use based on outcome
    // tokenIds[0] is typically YES, tokenIds[1] is typically NO
    let tokenIndex = 0;
    let price = prices[0] || 0.5;

    if (outcome) {
      const normalizedOutcome = outcome.toLowerCase().trim();
      if (normalizedOutcome === "no" || normalizedOutcome === "false") {
        tokenIndex = 1;
        price = prices[1] || 0.5;
      }
    }

    const tokenId = tokenIds[tokenIndex];
    if (tokenId) {
      runtime.logger.info(
        `[placeOrder] Found market: "${market.question}" token=${tokenId.slice(0, 16)}...`,
      );
      return {
        tokenId,
        question: market.question,
        price,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function buildCandidates(events: GammaEvent[]): MarketCandidate[] {
  const candidates: MarketCandidate[] = [];

  for (const event of events) {
    if (!event.markets) continue;
    for (const market of event.markets) {
      if (!market.active || market.closed || !market.clobTokenIds) continue;
      const candidate = createCandidateFromMarket(market, event.title);
      if (candidate) {
        candidates.push(candidate);
      }
    }
  }

  candidates.sort((a, b) => b.volume - a.volume);
  return candidates.slice(0, 5);
}

function createCandidateFromMarket(
  market: GammaMarket,
  eventTitle?: string,
): MarketCandidate | null {
  try {
    const tokenIds = JSON.parse(market.clobTokenIds ?? "[]") as string[];
    const outcomes = JSON.parse(market.outcomes ?? "[]") as string[];
    const pricesStr = JSON.parse(market.outcomePrices ?? "[]") as string[];
    const prices = pricesStr.map((p) => parseFloat(p));
    const volume = Number.parseFloat(market.volume ?? "0") || 0;

    if (tokenIds.length === 0) return null;

    return {
      question: market.question,
      eventTitle,
      tokenIds,
      outcomes,
      prices,
      volume,
    };
  } catch {
    return null;
  }
}

function selectTokenForOutcome(
  candidate: MarketCandidate,
  outcome: string | undefined,
): { tokenId: string; outcomeLabel: string; price: number } | null {
  let tokenIndex = 0;
  let outcomeLabel = candidate.outcomes[0] || "Yes";

  if (outcome) {
    const normalizedOutcome = outcome.toLowerCase().trim();
    if (normalizedOutcome === "no" || normalizedOutcome === "false") {
      tokenIndex = 1;
      outcomeLabel = candidate.outcomes[1] || "No";
    } else {
      tokenIndex = 0;
      outcomeLabel = candidate.outcomes[0] || "Yes";
    }
  }

  if (candidate.tokenIds.length === 0) return null;
  if (tokenIndex >= candidate.tokenIds.length) {
    tokenIndex = 0;
  }

  const tokenId = candidate.tokenIds[tokenIndex];
  const price = candidate.prices[tokenIndex] || 0.5;

  return { tokenId, outcomeLabel, price };
}

export const placeOrderAction: Action = {
  name: "POLYMARKET_PLACE_ORDER",
  similes: [
    "PLACE_ORDER",
    "CREATE_ORDER",
    "BUY_TOKEN",
    "SELL_TOKEN",
    "LIMIT_ORDER",
    "MARKET_ORDER",
    "TRADE",
    "ORDER",
    "BUY",
    "SELL",
    "PURCHASE",
    "SUBMIT_ORDER",
    "EXECUTE_ORDER",
    "BET",
    "WAGER",
    "PUT_MONEY",
    "PLACE_BET",
    "MAKE_BET",
    // Confirmation flow similes - when user confirms a pending order
    "CONFIRM",
    "CONFIRM_ORDER",
    "CONFIRM_BET",
    "CONFIRM_TRADE",
    "YES_EXECUTE",
    "EXECUTE",
    "DO_IT",
    "GO_AHEAD",
    "PROCEED",
  ],
  description:
    "Places a buy/sell order (bet) on Polymarket. Use when user says buy, sell, bet, wager, put money on, or confirms a trade. Will search for market by name if tokenId not provided. Executes immediately without asking for confirmation. Parameters: tokenId or marketName (required), outcome (yes/no), side (buy/sell, default buy), price (0.01-0.99, uses best available if omitted), size (dollar amount or shares, required), orderType (GTC/FOK/FAK, default GTC). Requires CLOB API credentials and private key.",

  parameters: [
    {
      name: "tokenId",
      description: "Token ID to trade",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "marketName",
      description: "Market name to search for",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "outcome",
      description: "Outcome to bet on: yes or no",
      required: false,
      schema: { type: "string" },
    },
    { name: "side", description: "BUY or SELL", required: false, schema: { type: "string" } },
    {
      name: "price",
      description: "Price per share (0.01-0.99)",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "size",
      description: "Number of shares or dollar amount",
      required: true,
      schema: { type: "number" },
    },
    {
      name: "orderType",
      description: "GTC, FOK, or FAK",
      required: false,
      schema: { type: "string" },
    },
  ],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const privateKey =
      runtime.getSetting("POLYMARKET_PRIVATE_KEY") ||
      runtime.getSetting("EVM_PRIVATE_KEY") ||
      runtime.getSetting("WALLET_PRIVATE_KEY") ||
      runtime.getSetting("PRIVATE_KEY");

    if (!privateKey) {
      runtime.logger.warn("[placeOrderAction] Private key is required for trading");
      return false;
    }

    const clobApiKey = runtime.getSetting("CLOB_API_KEY");
    const clobApiSecret =
      runtime.getSetting("CLOB_API_SECRET") || runtime.getSetting("CLOB_SECRET");
    const clobApiPassphrase =
      runtime.getSetting("CLOB_API_PASSPHRASE") || runtime.getSetting("CLOB_PASS_PHRASE");
    const allowCreate = runtime.getSetting("POLYMARKET_ALLOW_CREATE_API_KEY");
    const hasEnvCreds = Boolean(clobApiKey && clobApiSecret && clobApiPassphrase);
    const canCreateCreds = allowCreate !== "false" && allowCreate !== false;

    if (!hasEnvCreds && !canCreateCreds) {
      runtime.logger.warn(
        "[placeOrderAction] CLOB API credentials are required for trading. " +
          "Set CLOB_API_KEY/SECRET/PASSPHRASE or enable POLYMARKET_ALLOW_CREATE_API_KEY.",
      );
      return false;
    }

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, string | number | boolean>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    // Parse order parameters from LLM
    const llmResult = await callLLMWithTimeout<PlaceOrderParams>(
      runtime,
      state,
      orderTemplate,
      "placeOrderAction",
    );

    if (isLLMError(llmResult)) {
      await sendError(
        callback,
        "Could not parse order parameters from your request",
        "LLM parsing",
      );
      return {
        success: false,
        text: "Required order parameters not found",
        error: "parsing_failed",
      };
    }

    let tokenId = llmResult?.tokenId ?? "";
    let side = llmResult?.side?.toUpperCase() ?? "BUY";
    let price = llmResult?.price ?? 0;
    let orderType = llmResult?.orderType?.toUpperCase() ?? "GTC";
    const feeRateBps = llmResult?.feeRateBps ?? "0";
    const marketName = llmResult?.marketName;
    const outcome = llmResult?.outcome;
    let marketQuestion = "";

    // Extract dollar amount or shares from LLM result
    const dollarAmount = llmResult?.dollarAmount ?? 0;
    const sharesInput = llmResult?.shares ?? llmResult?.size ?? 0;
    let size = 0;
    let isDollarAmount = false;

    // If token ID looks like a condition ID (starts with 0x), look up the actual token
    if (tokenId?.startsWith("0x")) {
      await sendUpdate(callback, `🔍 Looking up market ${tokenId.slice(0, 16)}...`);
      try {
        const clobClient = await initializeClobClient(runtime);
        const market = await clobClient.getMarket(tokenId);
        if (market?.tokens?.length) {
          // Select token based on outcome (default to first token = Yes)
          const tokenIndex = outcome?.toLowerCase() === "no" ? 1 : 0;
          const selectedToken = market.tokens[tokenIndex] || market.tokens[0];
          tokenId = selectedToken.token_id;
          marketQuestion = market.question || "";
          if (price <= 0 && selectedToken.price) {
            price = parseFloat(selectedToken.price);
          }
          await sendUpdate(
            callback,
            `✓ Found token for ${selectedToken.outcome || (tokenIndex === 0 ? "Yes" : "No")}`,
          );
        } else {
          throw new Error("Market has no tokens");
        }
      } catch (error) {
        runtime.logger.error(`[placeOrderAction] Failed to look up condition ID:`, error);
        await sendError(
          callback,
          `Could not find market with condition ID ${tokenId.slice(0, 16)}...`,
          "The market may not exist or be inactive",
        );
        return {
          success: false,
          text: `Market not found for condition ID: ${tokenId.slice(0, 16)}...`,
          error: "market_not_found",
        };
      }
    }

    // If no token ID but we have a market name, search for it
    if ((!tokenId || tokenId === "MARKET_NAME_LOOKUP") && marketName) {
      await sendUpdate(callback, `🔍 Searching for "${marketName}" market...`);

      const searchResult = await searchMarketByName(runtime, marketName, outcome);

      if (searchResult.match) {
        tokenId = searchResult.match.tokenId;
        marketQuestion = searchResult.match.question;
        // Use market price if user didn't specify one
        if (price <= 0) {
          price = searchResult.match.price;
        }
        await sendUpdate(
          callback,
          `✓ Found: "${marketQuestion.slice(0, 50)}..." at ${(searchResult.match.price * 100).toFixed(0)}%`,
        );
      } else if (searchResult.candidates && searchResult.candidates.length > 0) {
        const bestCandidate = searchResult.candidates[0];
        const selection = selectTokenForOutcome(bestCandidate, outcome);
        const amountText =
          dollarAmount > 0
            ? `$${dollarAmount}`
            : sharesInput > 0
              ? `${sharesInput} shares`
              : "the requested amount";

        if (!selection) {
          await sendError(
            callback,
            `Could not select a tradeable token for "${bestCandidate.question}"`,
            "Please specify the exact market name",
          );
          return {
            success: false,
            text: `Market "${marketName}" not found`,
            error: "market_not_found",
          };
        }

        const candidateLines = searchResult.candidates
          .slice(0, 3)
          .map((c, i) => `  ${i + 1}. ${c.question}`)
          .join("\n");

        const responseText =
          `I couldn't find an exact match for "${marketName}", but here's the best match:\n\n` +
          `**${bestCandidate.question}**\n` +
          (bestCandidate.eventTitle ? `Event: ${bestCandidate.eventTitle}\n` : "") +
          `Proposed: place ${amountText} on ${selection.outcomeLabel} ` +
          `(token: ${selection.tokenId}).\n\n` +
          `Reply "confirm" to proceed, or provide the exact market name.\n\n` +
          `Other possible matches:\n${candidateLines}`;

        const responseContent: Content = {
          text: responseText,
          actions: ["POLYMARKET_PLACE_ORDER"],
        };

        if (callback) {
          await callback(responseContent);
        }

        return {
          success: false,
          text: responseText,
          error: "ambiguous_market",
        };
      } else {
        await sendError(
          callback,
          `Could not find an active market matching "${marketName}"`,
          "Try searching for markets first",
        );
        return {
          success: false,
          text: `Market "${marketName}" not found`,
          error: "market_not_found",
        };
      }
    }

    // Convert dollar amount to shares based on price
    // Must be done after price is determined (after market search)
    if (dollarAmount > 0) {
      isDollarAmount = true;
      // Calculate shares: dollarAmount / price = number of shares
      // e.g., $5 at $0.25/share = 20 shares
      if (price > 0) {
        size = Math.floor(dollarAmount / price);
        runtime.logger.info(
          `[placeOrderAction] Converting $${dollarAmount} to ${size} shares at $${price.toFixed(4)}/share`,
        );
      } else {
        // If we don't have a price yet, estimate with 0.5
        size = Math.floor(dollarAmount / 0.5);
      }
    } else if (sharesInput > 0) {
      size = sharesInput;
    }

    // Validate we have required params
    if (!tokenId) {
      await sendError(
        callback,
        "No token ID or market name provided",
        "Please specify a market name or token ID to trade",
      );
      return { success: false, text: "Missing token ID or market name", error: "missing_token" };
    }

    if (size <= 0) {
      await sendError(
        callback,
        "Invalid order size",
        "Please specify how many shares or dollars to bet",
      );
      return { success: false, text: "Invalid order size", error: "invalid_size" };
    }

    // Set defaults
    if (!["BUY", "SELL"].includes(side)) {
      side = "BUY";
    }

    if (price > 1.0) {
      price = price / 100; // Convert percentage to decimal
    }

    // If no price specified, we need to get best available
    if (price <= 0) {
      // Default to 50% if we can't determine price
      price = 0.5;
      runtime.logger.warn("[placeOrderAction] No price specified, defaulting to $0.50");
    }

    if (!["GTC", "FOK", "GTD", "FAK"].includes(orderType)) {
      orderType = "GTC";
    }

    // Calculate order value
    const orderValue = price * size;

    // Send acknowledgement BEFORE making the API call
    const ackParams: Record<string, string | number | boolean | undefined> = {
      side,
      price: `$${price.toFixed(2)} (${(price * 100).toFixed(0)}%)`,
      amount: isDollarAmount
        ? `$${dollarAmount} (${size} shares)`
        : `${size} shares ($${orderValue.toFixed(2)})`,
      orderType,
    };
    if (marketQuestion) {
      ackParams.market = `${marketQuestion.slice(0, 40)}...`;
    } else {
      ackParams.tokenId = `${tokenId.slice(0, 16)}...`;
    }

    await sendAcknowledgement(callback, "Placing order on Polymarket...", ackParams);
    if (orderValue < 0.5) {
      await sendError(
        callback,
        `Order value ($${orderValue.toFixed(2)}) is too small. Minimum order is typically $1.`,
        "Try increasing the size",
      );
      return {
        success: false,
        text: `Order value too small: $${orderValue.toFixed(2)}`,
        error: "min_order_value",
      };
    }

    let client: ClobClient;
    try {
      client = (await initializeClobClientWithCreds(runtime)) as ClobClient;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await sendError(callback, `Failed to initialize trading client: ${errMsg}`, "Authentication");
      return { success: false, text: `Client initialization failed: ${errMsg}`, error: errMsg };
    }

    // Validate token exists by checking order book
    try {
      const orderBook = await client.getOrderBook(tokenId);
      if (!orderBook || (!orderBook.bids?.length && !orderBook.asks?.length)) {
        runtime.logger.warn(
          `[placeOrderAction] Token ${tokenId.slice(0, 20)}... has no order book data`,
        );
        await sendError(
          callback,
          `Token not found or has no liquidity. The token ID may be invalid.`,
          `Token: ${tokenId.slice(0, 20)}...`,
        );
        return {
          success: false,
          text: `Invalid token or no liquidity: ${tokenId.slice(0, 20)}...`,
          error: "invalid_token",
        };
      }

      // If user didn't specify a price and we have order book data, use best available
      if (price <= 0 || price === 0.5) {
        const bestAsk = orderBook.asks?.[0]?.price;
        const bestBid = orderBook.bids?.[0]?.price;
        if (side === "BUY" && bestAsk) {
          price = parseFloat(bestAsk);
          runtime.logger.info(`[placeOrderAction] Using best ask price: $${price}`);
        } else if (side === "SELL" && bestBid) {
          price = parseFloat(bestBid);
          runtime.logger.info(`[placeOrderAction] Using best bid price: $${price}`);
        }
      }
    } catch (error) {
      runtime.logger.error(`[placeOrderAction] Failed to validate token:`, error);
      await sendError(
        callback,
        `Could not validate token. It may not exist or there's an API issue.`,
        `Token: ${tokenId.slice(0, 20)}...`,
      );
      return {
        success: false,
        text: `Token validation failed: ${tokenId.slice(0, 20)}...`,
        error: "token_validation_failed",
      };
    }

    // Round price to valid tick size (typically 0.01)
    price = Math.round(price * 100) / 100;

    // Ensure price is within valid range
    if (price <= 0 || price >= 1) {
      await sendError(callback, `Invalid price: $${price}. Price must be between $0.01 and $0.99.`);
      return { success: false, text: `Invalid price: ${price}`, error: "invalid_price" };
    }

    // Log order details before submission
    runtime.logger.info(
      `[placeOrderAction] Submitting order: tokenID=${tokenId.slice(0, 20)}..., ` +
        `side=${side}, price=${price}, size=${size}, orderType=${orderType}`,
    );

    const orderArgs: UserOrder = {
      tokenID: tokenId,
      price,
      side: side === "BUY" ? Side.BUY : Side.SELL,
      size,
      feeRateBps: parseFloat(feeRateBps),
    };

    let orderResponse: OrderResponse;

    try {
      if (orderType === "FOK" || orderType === "FAK") {
        const marketOrderType = orderType === "FAK" ? ClobOrderType.FAK : ClobOrderType.FOK;
        const marketOrderArgs = {
          tokenID: tokenId,
          price,
          amount: size,
          side: side === "BUY" ? Side.BUY : Side.SELL,
          feeRateBps: parseFloat(feeRateBps),
          orderType: marketOrderType as ClobOrderType.FOK | ClobOrderType.FAK,
        };
        orderResponse = (await client.createAndPostMarketOrder(marketOrderArgs)) as OrderResponse;
      } else {
        const clobOrderType = orderType === "GTD" ? ClobOrderType.GTD : ClobOrderType.GTC;
        orderResponse = (await client.createAndPostOrder(
          orderArgs,
          undefined,
          clobOrderType,
        )) as OrderResponse;
      }
    } catch (error) {
      // Enhanced error logging
      runtime.logger.error(`[placeOrderAction] Order exception:`, error);
      let errMsg = "Unknown error";
      if (error instanceof Error) {
        errMsg = error.message;
        // Check for nested error info
        const anyError = error as unknown as Record<string, unknown>;
        if (anyError.response) {
          runtime.logger.error(`[placeOrderAction] Response data:`, String(anyError.response));
        }
        if (anyError.cause) {
          runtime.logger.error(`[placeOrderAction] Error cause:`, String(anyError.cause));
        }
      } else if (typeof error === "object" && error !== null) {
        errMsg = JSON.stringify(error);
      } else {
        errMsg = String(error);
      }
      await sendError(
        callback,
        `Order submission failed: ${errMsg}`,
        `${side} ${size} @ $${price.toFixed(4)}`,
      );
      return {
        success: false,
        text: `Order failed: ${errMsg}`,
        error: errMsg,
        data: { tokenId, side, price: String(price), size: String(size) },
      };
    }

    let responseText: string;

    if (orderResponse.success) {
      // Invalidate both provider cache and account state cache
      await runtime.deleteCache(POLYMARKET_PROVIDER_CACHE_KEY);
      const service = runtime.getService(POLYMARKET_SERVICE_NAME) as PolymarketService | undefined;
      if (service) {
        service.invalidateAccountState();
      }
      const sideText = side.toLowerCase();
      const orderTypeText =
        orderType === "GTC" ? "limit" : orderType === "FOK" ? "market" : orderType.toLowerCase();
      const totalValue = (price * size).toFixed(4);

      responseText =
        `✅ **Order Placed Successfully**\n\n` +
        `**Order Details:**\n` +
        `• Type: ${orderTypeText} ${sideText} order\n`;

      if (marketQuestion) {
        responseText += `• Market: ${marketQuestion}\n`;
      }

      responseText +=
        `• Token ID: \`${tokenId.slice(0, 20)}...\`\n` +
        `• Side: ${side}\n` +
        `• Price: $${price.toFixed(4)} (${(price * 100).toFixed(2)}%)\n` +
        `• Size: ${size} shares\n` +
        `• Total Value: $${totalValue}\n\n` +
        `**Order Response:**\n` +
        `• Order ID: ${orderResponse.orderId ?? "Pending"}\n` +
        `• Status: ${orderResponse.status ?? "submitted"}`;

      if (orderResponse.orderHashes?.length) {
        responseText += `\n• Transaction Hash(es): ${orderResponse.orderHashes.join(", ")}`;
      }

      if (orderResponse.status === "matched") {
        responseText += "\n\n🎉 Your order was immediately matched!";
      } else if (orderResponse.status === "delayed") {
        responseText += "\n\n⏳ Your order is subject to a matching delay.";
      }
    } else {
      // Log the full response for debugging
      runtime.logger.error(
        `[placeOrderAction] Order failed. Full response: ${JSON.stringify(orderResponse)}`,
      );

      // Extract error from various possible fields
      const responseAny = orderResponse as unknown as Record<string, string>;
      const errorMsg =
        orderResponse.errorMsg ||
        responseAny.error ||
        responseAny.message ||
        responseAny.reason ||
        JSON.stringify(orderResponse);

      responseText =
        `❌ **Order Placement Failed**\n\n` +
        `**Error**: ${errorMsg}\n\n` +
        `**Order Details Attempted:**\n`;

      if (marketQuestion) {
        responseText += `• Market: ${marketQuestion}\n`;
      }

      responseText +=
        `• Token ID: ${tokenId}\n` +
        `• Side: ${side}\n` +
        `• Price: $${price.toFixed(4)}\n` +
        `• Size: ${size} shares`;
    }

    const responseContent: Content = {
      text: responseText,
      actions: ["POLYMARKET_PLACE_ORDER"],
    };

    if (callback) {
      await callback(responseContent);
    }

    return {
      success: orderResponse.success ?? false,
      text: responseText,
      data: {
        orderId: orderResponse.orderId ?? "",
        status: orderResponse.status ?? "",
        tokenId,
        marketQuestion,
        side,
        price: String(price),
        size: String(size),
        timestamp: new Date().toISOString(),
      },
    };
  },

  examples: [
    // Example 1: Bet by market name
    [
      { name: "{{user1}}", content: { text: "Put $5 on Yes for Miami Heat" } },
      {
        name: "{{user2}}",
        content: {
          text: "Searching for Miami Heat market and placing your bet.",
          action: "POLYMARKET_PLACE_ORDER",
        },
      },
    ],
    // Example 2: Bet on No outcome
    [
      { name: "{{user1}}", content: { text: "Bet $10 on No for the Thunder winning" } },
      {
        name: "{{user2}}",
        content: { text: "Placing $10 on No for Thunder.", action: "POLYMARKET_PLACE_ORDER" },
      },
    ],
    // Example 3: After seeing market results
    [
      { name: "{{user1}}", content: { text: "Show me the Bitcoin $100k market" } },
      {
        name: "{{user2}}",
        content: { text: "The Bitcoin $100k market: YES is at 35%, NO at 65%. Token: 0x123abc..." },
      },
      { name: "{{user1}}", content: { text: "Put $1 on Yes" } },
      {
        name: "{{user2}}",
        content: { text: "Placing $1 on Yes for Bitcoin $100k.", action: "POLYMARKET_PLACE_ORDER" },
      },
    ],
    // Example 4: With specific token ID
    [
      { name: "{{user1}}", content: { text: "Buy 50 shares of token 0xabc123 at 40 cents" } },
      {
        name: "{{user2}}",
        content: {
          text: "Placing limit buy order for 50 shares at $0.40.",
          action: "POLYMARKET_PLACE_ORDER",
        },
      },
    ],
    // Example 5: User asks about prices - should NOT place order
    [
      { name: "{{user1}}", content: { text: "What's the price on the election market?" } },
      {
        name: "{{user2}}",
        content: { text: "Let me fetch the current pricing.", action: "POLYMARKET_GET_TOKEN_INFO" },
      },
    ],
    // Example 6: Wager by name
    [
      { name: "{{user1}}", content: { text: "I want to wager $20 on the Lakers winning" } },
      {
        name: "{{user2}}",
        content: {
          text: "Searching for Lakers market and placing your $20 bet.",
          action: "POLYMARKET_PLACE_ORDER",
        },
      },
    ],
    // Example 7: CRITICAL - User confirms a proposed order
    [
      { name: "{{user1}}", content: { text: "I want to put $1 on No for Miami Heat Playoffs" } },
      {
        name: "{{user2}}",
        content: {
          text: "Confirm: place $1 on No for Miami Heat Playoffs at current best ask. Reply 'confirm' or 'yes, execute' to proceed.",
        },
      },
      { name: "{{user1}}", content: { text: "confirm" } },
      {
        name: "{{user2}}",
        content: {
          text: "Executing order: $1 on No for Miami Heat Playoffs.",
          action: "POLYMARKET_PLACE_ORDER",
        },
      },
    ],
    // Example 8: User says "yes" to confirm
    [
      { name: "{{user1}}", content: { text: "Bet $5 on Bitcoin hitting 100k" } },
      { name: "{{user2}}", content: { text: "I'll place $5 on Yes for Bitcoin $100k. Confirm?" } },
      { name: "{{user1}}", content: { text: "yes" } },
      {
        name: "{{user2}}",
        content: { text: "Placing the order now.", action: "POLYMARKET_PLACE_ORDER" },
      },
    ],
    // Example 9: User says "do it" or "go ahead"
    [
      { name: "{{user1}}", content: { text: "I want to bet on the election" } },
      {
        name: "{{user2}}",
        content: { text: "Found Trump vs Harris market. Place $10 on Trump at 52%?" },
      },
      { name: "{{user1}}", content: { text: "do it" } },
      {
        name: "{{user2}}",
        content: { text: "Executing order.", action: "POLYMARKET_PLACE_ORDER" },
      },
    ],
    // Example 10: User says "execute"
    [
      { name: "{{user1}}", content: { text: "Put $2 on No for the Celtics" } },
      {
        name: "{{user2}}",
        content: {
          text: "Ready to place $2 on No for Celtics NBA Championship at 15%. Say 'execute' to confirm.",
        },
      },
      { name: "{{user1}}", content: { text: "execute" } },
      {
        name: "{{user2}}",
        content: { text: "Submitting order.", action: "POLYMARKET_PLACE_ORDER" },
      },
    ],
  ],
};
