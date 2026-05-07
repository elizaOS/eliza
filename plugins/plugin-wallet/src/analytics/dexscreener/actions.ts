// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import type {
  Action,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { DexScreenerService } from "./service";
import type { DexScreenerBoostedToken } from "./types";

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

// Search Action
export const searchTokensAction: Action = {
  name: "DEXSCREENER_SEARCH",
  description:
    "Search for tokens or trading pairs on DexScreener by name, symbol, or contract address",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: unknown,
    options?: unknown,
  ): Promise<boolean> => {
    if (readStringParam(options, "tokenAddress", "address")) {
      return true;
    }
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content?.text || "";
    return (
      content.toLowerCase().includes("search") ||
      content.toLowerCase().includes("find") ||
      content.toLowerCase().includes("look for")
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<void> => {
    if (!callback) {
      console.error("No callback");
      return;
    }

    const service = runtime.getService("dexscreener") as DexScreenerService;
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content?.text || "";

    // Extract search query
    const queryMatch = content.match(
      /(?:search|find|look for)\s+(?:for\s+)?(.+?)(?:\s+on\s+dexscreener)?$/i,
    );

    if (!queryMatch) {
      callback({
        text: 'Please provide a search query. Example: "Search for PEPE"',
        action: "DEXSCREENER_SEARCH",
      });
      return;
    }

    const result = await service.search({ query: queryMatch[1].trim() });

    if (!result.success || !result.data) {
      callback({
        text: `Failed to search: ${result.error}`,
        action: "DEXSCREENER_SEARCH",
      });
      return;
    }

    const pairs = result.data.slice(0, 5); // Limit to 5 results

    if (pairs.length === 0) {
      callback({
        text: `No results found for "${queryMatch[1].trim()}"`,
        action: "DEXSCREENER_SEARCH",
      });
      return;
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

    callback({
      text: `**🔍 Search Results for "${queryMatch[1].trim()}"**\n\n${pairList}`,
      action: "DEXSCREENER_SEARCH",
      data: pairs,
    });
    return;
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
  ): Promise<boolean> => {
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
  ): Promise<void> => {
    if (!callback) {
      console.error("No callback");
      return;
    }

    const service = runtime.getService("dexscreener") as DexScreenerService;
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
      callback({
        text: 'Please provide a token address. Example: "Get token info for 0x..."',
        action: "DEXSCREENER_TOKEN_INFO",
      });
      return;
    }

    const result = await service.getTokenPairs({
      tokenAddress: addressMatch[0],
    });

    if (!result.success || !result.data) {
      callback({
        text: `Failed to get token info: ${result.error}`,
        action: "DEXSCREENER_TOKEN_INFO",
      });
      return;
    }

    const pairs = result.data;

    if (pairs.length === 0) {
      callback({
        text: `No pairs found for token ${addressMatch[0]}`,
        action: "DEXSCREENER_TOKEN_INFO",
      });
      return;
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

    callback({
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
    return;
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
  description:
    "Get trending tokens from DexScreener based on volume, price changes, and trading activity",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
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
  ): Promise<void> => {
    if (!callback) {
      console.error("No callback");
      return;
    }

    const service = runtime.getService("dexscreener") as DexScreenerService;
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content?.text || "";

    // Extract timeframe and limit
    const timeframeMatch = content.match(/\b(1h|6h|24h)\b/);
    const limitMatch = content.match(/top\s+(\d+)/i);

    const result = await service.getTrending({
      timeframe: (timeframeMatch?.[1] as "1h" | "6h" | "24h") || "24h",
      limit: limitMatch ? parseInt(limitMatch[1], 10) : 10,
    });

    if (!result.success || !result.data) {
      callback({
        text: `Failed to get trending tokens: ${result.error}`,
        action: "DEXSCREENER_TRENDING",
      });
      return;
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

    callback({
      text: `**🔥 Trending Tokens (${timeframeMatch?.[1] || "24h"})**\n\n${trendingList}`,
      action: "DEXSCREENER_TRENDING",
      data: pairs,
    });
    return;
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
  description:
    "Get newly created trading pairs from DexScreener, showing recently launched tokens and their initial liquidity",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
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
  ): Promise<void> => {
    if (!callback) {
      console.error("No callback");
      return;
    }

    const service = runtime.getService("dexscreener") as DexScreenerService;
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content?.text || "";

    // Extract chain and limit
    const chainMatch = content.match(/on\s+(\w+)/i);
    const limitMatch = content.match(/(\d+)\s+(?:new|latest)/i);

    const result = await service.getNewPairs({
      chain: chainMatch?.[1],
      limit: limitMatch ? parseInt(limitMatch[1], 10) : 10,
    });

    if (!result.success || !result.data) {
      callback({
        text: `Failed to get new pairs: ${result.error}`,
        action: "DEXSCREENER_NEW_PAIRS",
      });
      return;
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

    callback({
      text: `**🆕 New Trading Pairs${chainMatch ? ` on ${chainMatch[1]}` : ""}**\n\n${newPairsList}`,
      action: "DEXSCREENER_NEW_PAIRS",
      data: pairs,
    });
    return;
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
  description:
    "Get top trading pairs from a specific blockchain sorted by volume, liquidity, price change, or transaction count",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
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
  ): Promise<void> => {
    if (!callback) {
      console.error("No callback");
      return;
    }

    const service = runtime.getService("dexscreener") as DexScreenerService;
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
    const chain = chains.find((c) => content.toLowerCase().includes(c));

    if (!chain) {
      callback({
        text: "Please specify a blockchain. Supported: ethereum, bsc, polygon, arbitrum, optimism, base, solana, avalanche",
        action: "DEXSCREENER_CHAIN_PAIRS",
      });
      return;
    }

    // Extract sort criteria
    let sortBy: "volume" | "liquidity" | "priceChange" | "txns" = "volume";
    if (content.toLowerCase().includes("liquid")) sortBy = "liquidity";
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

    const result = await service.getPairsByChain({
      chain,
      sortBy,
      limit: 10,
    });

    if (!result.success || !result.data) {
      callback({
        text: `Failed to get ${chain} pairs: ${result.error}`,
        action: "DEXSCREENER_CHAIN_PAIRS",
      });
      return;
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

    callback({
      text: `**⛓️ Top ${chain.charAt(0).toUpperCase() + chain.slice(1)} Pairs by ${sortBy}**\n\n${pairsList}`,
      action: "DEXSCREENER_CHAIN_PAIRS",
      data: pairs,
    });
    return;
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
  description:
    "Get boosted (promoted/sponsored) tokens from DexScreener, showing tokens with paid promotional boosts",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
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
  ): Promise<void> => {
    if (!callback) {
      console.error("No callback");
      return;
    }

    const service = runtime.getService("dexscreener") as DexScreenerService;
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content?.text || "";

    // Check if asking for top or latest
    const isTop = content.toLowerCase().includes("top");

    const result = isTop
      ? await service.getTopBoostedTokens()
      : await service.getLatestBoostedTokens();

    if (!result.success || !result.data) {
      callback({
        text: `Failed to get boosted tokens: ${result.error}`,
        action: "DEXSCREENER_BOOSTED_TOKENS",
      });
      return;
    }

    const tokens = result.data.slice(0, 10);

    if (tokens.length === 0) {
      callback({
        text: "No boosted tokens found",
        action: "DEXSCREENER_BOOSTED_TOKENS",
      });
      return;
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

    callback({
      text: `**⚡ ${isTop ? "Top" : "Latest"} Boosted Tokens**\n\n${tokenList}`,
      action: "DEXSCREENER_BOOSTED_TOKENS",
      data: tokens,
    });
    return;
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
  description:
    "Get latest token profiles from DexScreener including social links, descriptions, and project information",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
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
  ): Promise<void> => {
    if (!callback) {
      console.error("No callback");
      return;
    }

    const service = runtime.getService("dexscreener") as DexScreenerService;

    const result = await service.getLatestTokenProfiles();

    if (!result.success || !result.data) {
      callback({
        text: `Failed to get token profiles: ${result.error}`,
        action: "DEXSCREENER_TOKEN_PROFILES",
      });
      return;
    }

    const profiles = result.data.slice(0, 5);

    if (profiles.length === 0) {
      callback({
        text: "No token profiles found",
        action: "DEXSCREENER_TOKEN_PROFILES",
      });
      return;
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

    callback({
      text: `**📋 Latest Token Profiles**\n\n${profileList}`,
      action: "DEXSCREENER_TOKEN_PROFILES",
      data: profiles,
    });
    return;
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
