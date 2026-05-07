// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { DexScreenerService } from "./service";
import type {
  DexScreenerBoostedToken,
  DexScreenerPair,
  DexScreenerProfile,
  DexScreenerServiceResponse,
} from "./types";

type DexScreenerPairListResponse = DexScreenerServiceResponse<
  DexScreenerPair[]
>;

function readParams(options?: unknown): Record<string, unknown> {
  const direct =
    options && typeof options === "object"
      ? (options as Record<string, unknown>)
      : {};
  const parameters =
    direct.parameters && typeof direct.parameters === "object"
      ? (direct.parameters as Record<string, unknown>)
      : {};
  return { ...direct, ...parameters };
}

function readStringParam(options: unknown, ...keys: string[]): string | null {
  const params = readParams(options);
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function _readNumberParam(options: unknown, key: string): number | null {
  const value = readParams(options)[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function _readBooleanParam(options: unknown, key: string): boolean | null {
  const value = readParams(options)[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return null;
}

function selectedContextMatches(
  state: unknown,
  contexts: readonly string[],
): boolean {
  const selected = new Set<string>();
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") selected.add(item);
    }
  };
  const typed = state as State | undefined;
  collect(
    (typed?.values as Record<string, unknown> | undefined)?.selectedContexts,
  );
  collect(
    (typed?.data as Record<string, unknown> | undefined)?.selectedContexts,
  );
  const contextObject = (typed?.data as Record<string, unknown> | undefined)
    ?.contextObject as
    | {
        trajectoryPrefix?: { selectedContexts?: unknown };
        metadata?: { selectedContexts?: unknown };
      }
    | undefined;
  collect(contextObject?.trajectoryPrefix?.selectedContexts);
  collect(contextObject?.metadata?.selectedContexts);
  return contexts.some((context) => selected.has(context));
}

const DEX_CONTEXTS = ["finance", "crypto", "wallet"] as const;
const DEX_INTENT_KEYWORDS = [
  "dexscreener",
  "dex",
  "token",
  "pair",
  "pairs",
  "trending",
  "boosted",
  "profile",
  "liquidity",
  "volume",
  "price",
  "chain",
  "ethereum",
  "solana",
  "base",
  "arbitrum",
  "crypto",
  "wallet",
  "cripto",
  "token",
  "precio",
  "liquidez",
  "chaîne",
  "prix",
  "liquidité",
  "krypto",
  "preis",
  "liquidität",
  "暗号",
  "トークン",
  "価格",
  "流動性",
  "加密",
  "代币",
  "价格",
  "流动性",
  "암호화폐",
  "토큰",
  "가격",
  "유동성",
] as const;

function hasDexIntent(
  message: Memory,
  state: unknown,
  keywords: readonly string[] = DEX_INTENT_KEYWORDS,
): boolean {
  const typed = state as State | undefined;
  const content =
    typeof message.content === "string"
      ? message.content
      : message.content?.text || "";
  const text = [
    content,
    typeof typed?.values?.recentMessages === "string"
      ? typed.values.recentMessages
      : "",
  ]
    .join("\n")
    .toLowerCase();
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

function callbackResult(
  callback: HandlerCallback | undefined,
  success: boolean,
  payload: { text: string; action: string; data?: unknown },
  error?: string,
): ActionResult {
  callback?.(payload);
  return {
    success,
    text: payload.text,
    ...(payload.data !== undefined
      ? { data: payload.data as ActionResult["data"] }
      : {}),
    ...(error ? { error } : {}),
  };
}

function getDexScreenerService(
  runtime: IAgentRuntime,
): DexScreenerService | null {
  const service = runtime.getService(
    "dexscreener",
  ) as DexScreenerService | null;
  return service && typeof service.search === "function" ? service : null;
}

function describeDexError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Search Action
export const searchTokensAction: Action = {
  name: "DEXSCREENER_SEARCH",
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  roleGate: { minRole: "USER" },
  description:
    "Search for tokens or trading pairs on DexScreener by name, symbol, or contract address",
  parameters: [
    {
      name: "query",
      description:
        "Token name, symbol, pair, or contract address to search for.",
      required: true,
      schema: { type: "string" },
    },
  ],

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: unknown,
    options?: unknown,
  ): Promise<boolean> => {
    if (readStringParam(options, "tokenAddress", "address")) {
      return true;
    }
    if (selectedContextMatches(state, DEX_CONTEXTS)) return true;
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content?.text || "";
    const lower = content.toLowerCase();
    return (
      hasDexIntent(message, state, [
        "dexscreener",
        "token",
        "pair",
        "crypto",
        "search",
        "find",
        "lookup",
        "buscar",
        "rechercher",
        "suchen",
        "検索",
        "搜索",
        "검색",
      ]) &&
      (lower.includes("search") ||
        lower.includes("find") ||
        lower.includes("look for"))
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = getDexScreenerService(runtime);
    if (!service) {
      return callbackResult(
        callback,
        false,
        {
          text: "DexScreener service is not available.",
          action: "DEXSCREENER_SEARCH",
        },
        "DEXSCREENER_SERVICE_UNAVAILABLE",
      );
    }
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content?.text || "";
    const explicitQuery = readStringParam(_options, "query", "token", "symbol");

    // Extract search query
    const queryMatch = explicitQuery
      ? [explicitQuery, explicitQuery]
      : content.match(
          /(?:search|find|look for)\s+(?:for\s+)?(.+?)(?:\s+on\s+dexscreener)?$/i,
        );

    if (!queryMatch) {
      return callbackResult(
        callback,
        false,
        {
          text: 'Please provide a search query. Example: "Search for PEPE"',
          action: "DEXSCREENER_SEARCH",
        },
        "MISSING_QUERY",
      );
    }

    let result: DexScreenerPairListResponse;
    try {
      result = await service.search({ query: queryMatch[1].trim() });
    } catch (error) {
      return callbackResult(
        callback,
        false,
        {
          text: `Failed to search: ${describeDexError(error)}`,
          action: "DEXSCREENER_SEARCH",
        },
        describeDexError(error),
      );
    }

    if (!result.success || !result.data) {
      return callbackResult(
        callback,
        false,
        {
          text: `Failed to search: ${result.error}`,
          action: "DEXSCREENER_SEARCH",
        },
        String(result.error ?? "DEXSCREENER_SEARCH_FAILED"),
      );
    }

    const pairs = result.data.slice(0, 5); // Limit to 5 results

    if (pairs.length === 0) {
      return callbackResult(
        callback,
        false,
        {
          text: `No results found for "${queryMatch[1].trim()}"`,
          action: "DEXSCREENER_SEARCH",
        },
        "NO_RESULTS",
      );
    }

    const pairList = pairs
      .map((pair, i) => {
        const priceChange = service.formatPriceChange(pair.priceChange.h24);
        return (
          `**${i + 1}. ${pair.baseToken.symbol}/${pair.quoteToken.symbol}** on ${pair.dexId} (${pair.chainId})\n` +
          `   💰 Price: ${service.formatPrice(pair.priceUsd || pair.priceNative)}\n` +
          `   📈 24h: ${priceChange} | Vol: ${service.formatUsdValue(pair.volume.h24)}\n` +
          `   💧 Liq: ${pair.liquidity?.usd ? service.formatUsdValue(pair.liquidity.usd) : "N/A"}\n` +
          `   🔗 ${pair.url}`
        );
      })
      .join("\n\n");

    return callbackResult(callback, true, {
      text: `**🔍 Search Results for "${queryMatch[1].trim()}"**\n\n${pairList}`,
      action: "DEXSCREENER_SEARCH",
      data: pairs,
    });
  },

  similes: ["find token", "look for", "search dexscreener"],

  examples: [
    [
      {
        name: "Alice",
        content: { text: "Search for PEPE tokens" },
      },
      {
        name: "Bob",
        content: { text: "Find USDC pairs on dexscreener" },
      },
    ],
  ],
};

// Get Token Info Action
export const getTokenInfoAction: Action = {
  name: "DEXSCREENER_TOKEN_INFO",
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  roleGate: { minRole: "USER" },
  description:
    "Get detailed information about a specific token including price, volume, liquidity, and trading pairs from DexScreener",
  parameters: [
    {
      name: "tokenAddress",
      description: "Token contract address to look up on DexScreener.",
      required: false,
      schema: { type: "string" },
    },
  ],

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: unknown,
  ): Promise<boolean> => {
    if (readStringParam(options, "tokenAddress", "address")) return true;
    if (selectedContextMatches(state, DEX_CONTEXTS)) return true;
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content?.text || "";
    return (
      content.toLowerCase().includes("token") &&
      (content.toLowerCase().includes("info") ||
        content.toLowerCase().includes("details") ||
        content.toLowerCase().includes("price"))
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = getDexScreenerService(runtime);
    if (!service) {
      return callbackResult(
        callback,
        false,
        {
          text: "DexScreener service is not available.",
          action: "DEXSCREENER_TOKEN_INFO",
        },
        "DEXSCREENER_SERVICE_UNAVAILABLE",
      );
    }
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content?.text || "";

    // Extract token address
    const explicitAddress = readStringParam(options, "tokenAddress", "address");
    const addressMatch = explicitAddress
      ? [explicitAddress]
      : content.match(/0x[a-fA-F0-9]{40}/);

    if (!addressMatch) {
      return callbackResult(
        callback,
        false,
        {
          text: 'Please provide a token address. Example: "Get token info for 0x..."',
          action: "DEXSCREENER_TOKEN_INFO",
        },
        "MISSING_TOKEN_ADDRESS",
      );
    }

    let result: DexScreenerPairListResponse;
    try {
      result = await service.getTokenPairs({
        tokenAddress: addressMatch[0],
      });
    } catch (error) {
      return callbackResult(
        callback,
        false,
        {
          text: `Failed to get token info: ${describeDexError(error)}`,
          action: "DEXSCREENER_TOKEN_INFO",
        },
        describeDexError(error),
      );
    }

    if (!result.success || !result.data) {
      return callbackResult(
        callback,
        false,
        {
          text: `Failed to get token info: ${result.error}`,
          action: "DEXSCREENER_TOKEN_INFO",
        },
        String(result.error ?? "DEXSCREENER_TOKEN_INFO_FAILED"),
      );
    }

    const pairs = result.data;

    if (pairs.length === 0) {
      return callbackResult(
        callback,
        false,
        {
          text: `No pairs found for token ${addressMatch[0]}`,
          action: "DEXSCREENER_TOKEN_INFO",
        },
        "NO_PAIRS",
      );
    }

    // Get the most liquid pair
    const mainPair = pairs.reduce((prev, curr) =>
      (curr.liquidity?.usd || 0) > (prev.liquidity?.usd || 0) ? curr : prev,
    );

    const pairList = pairs
      .slice(0, 3)
      .map(
        (pair) =>
          `• **${pair.baseToken.symbol}/${pair.quoteToken.symbol}** on ${pair.dexId} (${pair.chainId})\n` +
          `  Price: ${service.formatPrice(pair.priceUsd || pair.priceNative)} | Liq: ${pair.liquidity?.usd ? service.formatUsdValue(pair.liquidity.usd) : "N/A"}`,
      )
      .join("\n");

    return callbackResult(callback, true, {
      text:
        `**📊 Token Information**\n\n` +
        `**Token:** ${mainPair.baseToken.name} (${mainPair.baseToken.symbol})\n` +
        `**Address:** \`${mainPair.baseToken.address}\`\n` +
        `**Price:** ${service.formatPrice(mainPair.priceUsd || mainPair.priceNative)}\n` +
        `**24h Change:** ${service.formatPriceChange(mainPair.priceChange.h24)}\n` +
        `**24h Volume:** ${service.formatUsdValue(mainPair.volume.h24)}\n` +
        `**Market Cap:** ${mainPair.marketCap ? service.formatUsdValue(mainPair.marketCap) : "N/A"}\n` +
        `**FDV:** ${mainPair.fdv ? service.formatUsdValue(mainPair.fdv) : "N/A"}\n\n` +
        `**Top Trading Pairs:**\n${pairList}`,
      action: "DEXSCREENER_TOKEN_INFO",
      data: pairs,
    });
  },

  similes: ["token details", "token price", "get token", "check token"],

  examples: [
    [
      {
        name: "Alice",
        content: {
          text: "Get token info for 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        },
      },
      {
        name: "Bob",
        content: { text: "What is the price of token 0x..." },
      },
    ],
  ],
};

// Get Trending Tokens Action
export const getTrendingAction: Action = {
  name: "DEXSCREENER_TRENDING",
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  roleGate: { minRole: "USER" },
  description:
    "Get trending tokens from DexScreener based on volume, price changes, and trading activity",
  parameters: [
    {
      name: "timeframe",
      description: "Trending window.",
      required: false,
      schema: { type: "string", enum: ["1h", "6h", "24h"], default: "24h" },
    },
    {
      name: "limit",
      description: "Maximum number of trending pairs to return.",
      required: false,
      schema: { type: "number", minimum: 1, maximum: 25, default: 10 },
    },
  ],

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> => {
    if (selectedContextMatches(state, DEX_CONTEXTS)) return true;
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content?.text || "";
    return (
      content.toLowerCase().includes("trending") ||
      content.toLowerCase().includes("hot") ||
      content.toLowerCase().includes("popular") ||
      content.toLowerCase().includes("gainers")
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = getDexScreenerService(runtime);
    if (!service) {
      return callbackResult(
        callback,
        false,
        {
          text: "DexScreener service is not available.",
          action: "DEXSCREENER_TRENDING",
        },
        "DEXSCREENER_SERVICE_UNAVAILABLE",
      );
    }
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content?.text || "";

    // Extract timeframe and limit
    const timeframeMatch = content.match(/\b(1h|6h|24h)\b/);
    const limitMatch = content.match(/top\s+(\d+)/i);
    const explicitTimeframe = readStringParam(_options, "timeframe");
    const timeframe =
      explicitTimeframe === "1h" ||
      explicitTimeframe === "6h" ||
      explicitTimeframe === "24h"
        ? explicitTimeframe
        : (timeframeMatch?.[1] as "1h" | "6h" | "24h") || "24h";
    const limit = Math.min(
      25,
      Math.max(
        1,
        readNumberParam(_options, "limit") ??
          (limitMatch ? parseInt(limitMatch[1], 10) : 10),
      ),
    );

    let result: DexScreenerPairListResponse;
    try {
      result = await service.getTrending({
        timeframe,
        limit,
      });
    } catch (error) {
      return callbackResult(
        callback,
        false,
        {
          text: `Failed to get trending tokens: ${describeDexError(error)}`,
          action: "DEXSCREENER_TRENDING",
        },
        describeDexError(error),
      );
    }

    if (!result.success || !result.data) {
      return callbackResult(
        callback,
        false,
        {
          text: `Failed to get trending tokens: ${result.error}`,
          action: "DEXSCREENER_TRENDING",
        },
        String(result.error ?? "DEXSCREENER_TRENDING_FAILED"),
      );
    }

    const pairs = result.data;

    const trendingList = pairs
      .map((pair, i) => {
        const priceChange = service.formatPriceChange(pair.priceChange.h24);
        return (
          `**${i + 1}. ${pair.baseToken.symbol}/${pair.quoteToken.symbol}**\n` +
          `   💰 ${service.formatPrice(pair.priceUsd || pair.priceNative)} (${priceChange})\n` +
          `   📊 Vol: ${service.formatUsdValue(pair.volume.h24)} | MCap: ${pair.marketCap ? service.formatUsdValue(pair.marketCap) : "N/A"}\n` +
          `   🔥 Buys: ${pair.txns.h24.buys} | Sells: ${pair.txns.h24.sells}`
        );
      })
      .join("\n\n");

    return callbackResult(callback, true, {
      text: `**🔥 Trending Tokens (${timeframe})**\n\n${trendingList}`,
      action: "DEXSCREENER_TRENDING",
      data: pairs,
    });
  },

  similes: ["hot tokens", "popular coins", "top gainers", "what's trending"],

  examples: [
    [
      {
        name: "Alice",
        content: { text: "Show me trending tokens on DexScreener" },
      },
      {
        name: "Bob",
        content: { text: "What are the top 5 hot tokens in the last 6h?" },
      },
    ],
  ],
};

// Get New Pairs Action
export const getNewPairsAction: Action = {
  name: "DEXSCREENER_NEW_PAIRS",
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  roleGate: { minRole: "USER" },
  description:
    "Get newly created trading pairs from DexScreener, showing recently launched tokens and their initial liquidity",
  parameters: [
    {
      name: "chain",
      description: "Optional chain id/name to filter new pairs.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "limit",
      description: "Maximum number of new pairs to return.",
      required: false,
      schema: { type: "number", minimum: 1, maximum: 25, default: 10 },
    },
  ],

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> => {
    if (selectedContextMatches(state, DEX_CONTEXTS)) return true;
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content?.text || "";
    return (
      content.toLowerCase().includes("new") &&
      (content.toLowerCase().includes("pairs") ||
        content.toLowerCase().includes("tokens") ||
        content.toLowerCase().includes("listings"))
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = getDexScreenerService(runtime);
    if (!service) {
      return callbackResult(
        callback,
        false,
        {
          text: "DexScreener service is not available.",
          action: "DEXSCREENER_NEW_PAIRS",
        },
        "DEXSCREENER_SERVICE_UNAVAILABLE",
      );
    }
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content?.text || "";

    // Extract chain and limit
    const chainMatch = content.match(/on\s+(\w+)/i);
    const limitMatch = content.match(/(\d+)\s+(?:new|latest)/i);
    const chain = readStringParam(_options, "chain") ?? chainMatch?.[1];
    const limit = Math.min(
      25,
      Math.max(
        1,
        readNumberParam(_options, "limit") ??
          (limitMatch ? parseInt(limitMatch[1], 10) : 10),
      ),
    );

    let result: DexScreenerPairListResponse;
    try {
      result = await service.getNewPairs({
        chain,
        limit,
      });
    } catch (error) {
      return callbackResult(
        callback,
        false,
        {
          text: `Failed to get new pairs: ${describeDexError(error)}`,
          action: "DEXSCREENER_NEW_PAIRS",
        },
        describeDexError(error),
      );
    }

    if (!result.success || !result.data) {
      return callbackResult(
        callback,
        false,
        {
          text: `Failed to get new pairs: ${result.error}`,
          action: "DEXSCREENER_NEW_PAIRS",
        },
        String(result.error ?? "DEXSCREENER_NEW_PAIRS_FAILED"),
      );
    }

    const pairs = result.data;

    const newPairsList = pairs
      .map((pair, i) => {
        const age = pair.pairCreatedAt
          ? `${Math.floor((Date.now() - pair.pairCreatedAt) / 60000)} mins ago`
          : "Unknown";
        return (
          `**${i + 1}. ${pair.baseToken.symbol}/${pair.quoteToken.symbol}** ${pair.labels?.includes("new") ? "🆕" : ""}\n` +
          `   ⏰ Created: ${age} on ${pair.dexId} (${pair.chainId})\n` +
          `   💰 Price: ${service.formatPrice(pair.priceUsd || pair.priceNative)}\n` +
          `   💧 Liquidity: ${pair.liquidity?.usd ? service.formatUsdValue(pair.liquidity.usd) : "N/A"}`
        );
      })
      .join("\n\n");

    return callbackResult(callback, true, {
      text: `**🆕 New Trading Pairs${chain ? ` on ${chain}` : ""}**\n\n${newPairsList}`,
      action: "DEXSCREENER_NEW_PAIRS",
      data: pairs,
    });
  },

  similes: ["new listings", "latest pairs", "new tokens", "fresh pairs"],

  examples: [
    [
      {
        name: "Alice",
        content: { text: "Show me new pairs on DexScreener" },
      },
      {
        name: "Bob",
        content: { text: "What are the 5 new tokens on ethereum?" },
      },
    ],
  ],
};

// Get Pairs by Chain Action
export const getPairsByChainAction: Action = {
  name: "DEXSCREENER_CHAIN_PAIRS",
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  roleGate: { minRole: "USER" },
  description:
    "Get top trading pairs from a specific blockchain sorted by volume, liquidity, price change, or transaction count",
  parameters: [
    {
      name: "chain",
      description: "Chain id/name to inspect.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "sortBy",
      description: "Metric used to rank pairs.",
      required: false,
      schema: {
        type: "string",
        enum: ["volume", "liquidity", "priceChange", "txns"],
        default: "volume",
      },
    },
    {
      name: "limit",
      description: "Maximum number of chain pairs to return.",
      required: false,
      schema: { type: "number", minimum: 1, maximum: 25, default: 10 },
    },
  ],

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: unknown,
  ): Promise<boolean> => {
    if (readStringParam(options, "chain")) return true;
    if (selectedContextMatches(state, DEX_CONTEXTS)) return true;
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content?.text || "";
    const chains = [
      "ethereum",
      "bsc",
      "polygon",
      "arbitrum",
      "optimism",
      "base",
      "solana",
      "avalanche",
    ];
    return chains.some((chain) => content.toLowerCase().includes(chain));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = getDexScreenerService(runtime);
    if (!service) {
      return callbackResult(
        callback,
        false,
        {
          text: "DexScreener service is not available.",
          action: "DEXSCREENER_CHAIN_PAIRS",
        },
        "DEXSCREENER_SERVICE_UNAVAILABLE",
      );
    }
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content?.text || "";

    // Extract chain
    const chains = [
      "ethereum",
      "bsc",
      "polygon",
      "arbitrum",
      "optimism",
      "base",
      "solana",
      "avalanche",
    ];
    const chain =
      readStringParam(_options, "chain") ??
      chains.find((c) => content.toLowerCase().includes(c));

    if (!chain) {
      return callbackResult(
        callback,
        false,
        {
          text: "Please specify a blockchain. Supported: ethereum, bsc, polygon, arbitrum, optimism, base, solana, avalanche",
          action: "DEXSCREENER_CHAIN_PAIRS",
        },
        "MISSING_CHAIN",
      );
    }

    // Extract sort criteria
    const requestedSort = readStringParam(_options, "sortBy");
    let sortBy: "volume" | "liquidity" | "priceChange" | "txns" =
      requestedSort === "volume" ||
      requestedSort === "liquidity" ||
      requestedSort === "priceChange" ||
      requestedSort === "txns"
        ? requestedSort
        : "volume";
    if (sortBy === "volume" && content.toLowerCase().includes("liquid"))
      sortBy = "liquidity";
    else if (
      content.toLowerCase().includes("gain") ||
      content.toLowerCase().includes("change")
    )
      sortBy = "priceChange";
    else if (
      content.toLowerCase().includes("active") ||
      content.toLowerCase().includes("trades")
    )
      sortBy = "txns";

    let result: DexScreenerPairListResponse;
    try {
      const limit = Math.min(
        25,
        Math.max(1, readNumberParam(_options, "limit") ?? 10),
      );
      result = await service.getPairsByChain({
        chain,
        sortBy,
        limit,
      });
    } catch (error) {
      return callbackResult(
        callback,
        false,
        {
          text: `Failed to get ${chain} pairs: ${describeDexError(error)}`,
          action: "DEXSCREENER_CHAIN_PAIRS",
        },
        describeDexError(error),
      );
    }

    if (!result.success || !result.data) {
      return callbackResult(
        callback,
        false,
        {
          text: `Failed to get ${chain} pairs: ${result.error}`,
          action: "DEXSCREENER_CHAIN_PAIRS",
        },
        String(result.error ?? "DEXSCREENER_CHAIN_PAIRS_FAILED"),
      );
    }

    const pairs = result.data;

    const pairsList = pairs
      .slice(0, 5)
      .map((pair, i) => {
        const txnsH24 = pair.txns?.h24;
        const metric =
          sortBy === "volume"
            ? `Vol: ${pair.volume?.h24 != null ? service.formatUsdValue(pair.volume.h24) : "N/A"}`
            : sortBy === "liquidity"
              ? `Liq: ${pair.liquidity?.usd ? service.formatUsdValue(pair.liquidity.usd) : "N/A"}`
              : sortBy === "priceChange"
                ? `24h: ${pair.priceChange?.h24 != null ? service.formatPriceChange(pair.priceChange.h24) : "N/A"}`
                : `Trades: ${txnsH24 ? txnsH24.buys + txnsH24.sells : "N/A"}`;
        return (
          `**${i + 1}. ${pair.baseToken.symbol}/${pair.quoteToken.symbol}** on ${pair.dexId}\n` +
          `   💰 ${service.formatPrice(pair.priceUsd || pair.priceNative)} | ${metric}`
        );
      })
      .join("\n\n");

    return callbackResult(callback, true, {
      text: `**⛓️ Top ${chain.charAt(0).toUpperCase() + chain.slice(1)} Pairs by ${sortBy}**\n\n${pairsList}`,
      action: "DEXSCREENER_CHAIN_PAIRS",
      data: pairs,
    });
  },

  similes: ["tokens on", "pairs on", "top on"],

  examples: [
    [
      {
        name: "Alice",
        content: { text: "Show me top tokens on ethereum" },
      },
      {
        name: "Bob",
        content: { text: "What are the most liquid pairs on polygon?" },
      },
    ],
  ],
};

// Get Boosted Tokens Action
export const getBoostedTokensAction: Action = {
  name: "DEXSCREENER_BOOSTED_TOKENS",
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  roleGate: { minRole: "USER" },
  description:
    "Get boosted (promoted/sponsored) tokens from DexScreener, showing tokens with paid promotional boosts",
  parameters: [
    {
      name: "top",
      description:
        "When true, return top boosted tokens instead of latest boosted tokens.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> => {
    if (selectedContextMatches(state, DEX_CONTEXTS)) return true;
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content?.text || "";
    return (
      content.toLowerCase().includes("boosted") ||
      content.toLowerCase().includes("promoted") ||
      content.toLowerCase().includes("sponsored")
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = getDexScreenerService(runtime);
    if (!service) {
      return callbackResult(
        callback,
        false,
        {
          text: "DexScreener service is not available.",
          action: "DEXSCREENER_BOOSTED_TOKENS",
        },
        "DEXSCREENER_SERVICE_UNAVAILABLE",
      );
    }
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content?.text || "";

    // Check if asking for top or latest
    const isTop =
      readBooleanParam(_options, "top") ??
      content.toLowerCase().includes("top");

    let result: DexScreenerServiceResponse<DexScreenerBoostedToken[]>;
    try {
      result = isTop
        ? await service.getTopBoostedTokens()
        : await service.getLatestBoostedTokens();
    } catch (error) {
      return callbackResult(
        callback,
        false,
        {
          text: `Failed to get boosted tokens: ${describeDexError(error)}`,
          action: "DEXSCREENER_BOOSTED_TOKENS",
        },
        describeDexError(error),
      );
    }

    if (!result.success || !result.data) {
      return callbackResult(
        callback,
        false,
        {
          text: `Failed to get boosted tokens: ${result.error}`,
          action: "DEXSCREENER_BOOSTED_TOKENS",
        },
        String(result.error ?? "DEXSCREENER_BOOSTED_TOKENS_FAILED"),
      );
    }

    const tokens = result.data.slice(0, 10);

    if (tokens.length === 0) {
      return callbackResult(
        callback,
        false,
        {
          text: "No boosted tokens found",
          action: "DEXSCREENER_BOOSTED_TOKENS",
        },
        "NO_BOOSTED_TOKENS",
      );
    }

    const tokenList = tokens
      .map((token: DexScreenerBoostedToken, i: number) => {
        return (
          `**${i + 1}. ${token.tokenAddress}** on ${token.chainId}\n` +
          `   💰 Boost Amount: ${token.amount} (Total: ${token.totalAmount})\n` +
          `   📝 ${token.description || "No description"}\n` +
          `   🔗 ${token.url}`
        );
      })
      .join("\n\n");

    return callbackResult(callback, true, {
      text: `**⚡ ${isTop ? "Top" : "Latest"} Boosted Tokens**\n\n${tokenList}`,
      action: "DEXSCREENER_BOOSTED_TOKENS",
      data: tokens,
    });
  },

  similes: ["promoted tokens", "sponsored tokens", "boosted coins"],

  examples: [
    [
      {
        name: "Alice",
        content: { text: "Show me boosted tokens on DexScreener" },
      },
      {
        name: "Bob",
        content: { text: "What are the top promoted tokens?" },
      },
    ],
  ],
};

// Get Token Profiles Action
export const getTokenProfilesAction: Action = {
  name: "DEXSCREENER_TOKEN_PROFILES",
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  roleGate: { minRole: "USER" },
  description:
    "Get latest token profiles from DexScreener including social links, descriptions, and project information",
  parameters: [
    {
      name: "limit",
      description: "Maximum number of token profiles to include.",
      required: false,
      schema: { type: "number", default: 10 },
    },
  ],

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> => {
    if (selectedContextMatches(state, DEX_CONTEXTS)) return true;
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content?.text || "";
    return (
      content.toLowerCase().includes("profile") &&
      content.toLowerCase().includes("token")
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = getDexScreenerService(runtime);
    if (!service) {
      return callbackResult(
        callback,
        false,
        {
          text: "DexScreener service is not available.",
          action: "DEXSCREENER_TOKEN_PROFILES",
        },
        "DEXSCREENER_SERVICE_UNAVAILABLE",
      );
    }

    let result: DexScreenerServiceResponse<DexScreenerProfile[]>;
    try {
      result = await service.getLatestTokenProfiles();
    } catch (error) {
      return callbackResult(
        callback,
        false,
        {
          text: `Failed to get token profiles: ${describeDexError(error)}`,
          action: "DEXSCREENER_TOKEN_PROFILES",
        },
        describeDexError(error),
      );
    }

    if (!result.success || !result.data) {
      return callbackResult(
        callback,
        false,
        {
          text: `Failed to get token profiles: ${result.error}`,
          action: "DEXSCREENER_TOKEN_PROFILES",
        },
        String(result.error ?? "DEXSCREENER_TOKEN_PROFILES_FAILED"),
      );
    }

    const profiles = result.data.slice(0, 5);

    if (profiles.length === 0) {
      return callbackResult(
        callback,
        false,
        {
          text: "No token profiles found",
          action: "DEXSCREENER_TOKEN_PROFILES",
        },
        "NO_TOKEN_PROFILES",
      );
    }

    const profileList = profiles
      .map((profile, i) => {
        const links =
          profile.links?.map((l) => `[${l.label}](${l.url})`).join(" | ") ||
          "No links";
        return (
          `**${i + 1}. ${profile.tokenAddress}** on ${profile.chainId}\n` +
          `   📝 ${profile.description || "No description"}\n` +
          `   🔗 Links: ${links}\n` +
          `   🌐 ${profile.url}`
        );
      })
      .join("\n\n");

    return callbackResult(callback, true, {
      text: `**📋 Latest Token Profiles**\n\n${profileList}`,
      action: "DEXSCREENER_TOKEN_PROFILES",
      data: profiles,
    });
  },

  similes: ["token profiles", "token details page"],

  examples: [
    [
      {
        name: "Alice",
        content: { text: "Show me latest token profiles" },
      },
    ],
  ],
};

// Export all actions
export const dexscreenerActions = [
  searchTokensAction,
  getTokenInfoAction,
  getTrendingAction,
  getNewPairsAction,
  getPairsByChainAction,
  getBoostedTokensAction,
  getTokenProfilesAction,
];
