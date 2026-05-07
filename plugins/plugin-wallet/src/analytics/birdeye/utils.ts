// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import { logger } from "@elizaos/core";
import type { BirdeyeApiParams } from "./types/api/common";
import type {
  TokenMarketSearchResponse,
  TokenResult,
} from "./types/api/search";
import type { TokenMetadataSingleResponse } from "./types/api/token";
import type { BaseAddress, BirdeyeSupportedChain } from "./types/shared";

// Constants
export const BASE_URL = "https://public-api.birdeye.so";

export const BIRDEYE_SUPPORTED_CHAINS = [
  "solana",
  "ethereum",
  "arbitrum",
  "avalanche",
  "bsc",
  "optimism",
  "polygon",
  "base",
  "zksync",
  "sui",
  "evm", // EVM-compatible chains but we don't know the chain
] as const;

// Chain abbreviations and alternative names mapping
export const CHAIN_ALIASES: Record<string, BirdeyeSupportedChain> = {
  // Solana
  sol: "solana",

  // Ethereum
  eth: "ethereum",
  ether: "ethereum",

  // Arbitrum
  arb: "arbitrum",
  arbitrumone: "arbitrum",

  // Avalanche
  avax: "avalanche",

  // BSC
  bnb: "bsc",
  binance: "bsc",
  "binance smart chain": "bsc",

  // Optimism
  op: "optimism",
  opti: "optimism",

  // Polygon
  matic: "polygon",
  poly: "polygon",

  // Base
  // no common abbreviations

  // zkSync
  zks: "zksync",
  zk: "zksync",

  // Sui
  // no common abbreviations
} as const;

export class BirdeyeApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "BirdeyeApiError";
  }
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

// Time-related types and constants
export const TIME_UNITS = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86400,
  week: 604800,
  month: 2592000,
} as const;

export const TIMEFRAME_KEYWORDS = {
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "2h": 7200,
  "4h": 14400,
  "6h": 21600,
  "12h": 43200,
  "1d": 86400,
  "1w": 604800,
} as const;

export type TimeUnit = keyof typeof TIME_UNITS;
export type Timeframe = keyof typeof TIMEFRAME_KEYWORDS;

// Helper functions
/**
 * Extract blockchain chain from address with optional explicit chain setting
 * @param text - The wallet address to analyze (optional if explicitChain is provided)
 * @param explicitChain - Optional explicit chain specification (from BIRDEYE_CHAIN setting)
 * @returns The detected or specified chain
 * @throws Error if address format is invalid or EVM address without explicit chain
 */
export const extractChain = (
  text?: string,
  explicitChain?: string,
): BirdeyeSupportedChain => {
  // First, check for explicit chain setting
  if (explicitChain) {
    const normalizedChain = explicitChain.toLowerCase();
    // Check if it's a valid chain or alias
    if (
      BIRDEYE_SUPPORTED_CHAINS.includes(
        normalizedChain as BirdeyeSupportedChain,
      )
    ) {
      return normalizedChain as BirdeyeSupportedChain;
    }
    // Check aliases
    if (CHAIN_ALIASES[normalizedChain]) {
      return CHAIN_ALIASES[normalizedChain];
    }
    throw new Error(
      `Invalid chain: "${explicitChain}". Must be one of: ${BIRDEYE_SUPPORTED_CHAINS.join(", ")}`,
    );
  }

  // Validate input
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    throw new Error("Invalid address: empty or non-string value provided");
  }

  const trimmedText = text.trim();

  // Check for SUI address (0x followed by 64 hex chars)
  if (trimmedText.match(/^0x[a-fA-F0-9]{64}$/)) {
    return "sui";
  }

  // Check for EVM address (0x followed by 40 hex chars)
  if (trimmedText.match(/^0x[a-fA-F0-9]{40}$/)) {
    // Build EVM chain list dynamically from supported chains (exclude solana and sui)
    const evmChains = BIRDEYE_SUPPORTED_CHAINS.filter(
      (chain) => chain !== "solana" && chain !== "sui",
    ).join(", ");
    throw new Error(
      `EVM address detected but specific chain unknown. Please set BIRDEYE_CHAIN environment variable to one of: ${evmChains}`,
    );
  }

  // Check for Solana address (base58, typically 32-44 chars, no 0x prefix)
  if (trimmedText.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
    return "solana";
  }

  // Invalid address format
  throw new Error(
    `Invalid address format: "${trimmedText}". Expected Solana (base58), EVM (0x + 40 hex), or Sui (0x + 64 hex) address.`,
  );
};

export const extractAddresses = (text: string): BaseAddress[] => {
  if (!text?.match) return [];
  const addresses: BaseAddress[] = [];

  // Sui addresses (0x followed by 64 hex chars). Extract first so the EVM
  // matcher does not take the 40-char prefix of a Sui address.
  const suiAddresses = text.match(/0x[a-fA-F0-9]{64}(?![a-fA-F0-9])/g);
  if (suiAddresses) {
    addresses.push(
      ...suiAddresses.map((address) => ({
        address,
        chain: "sui" as BirdeyeSupportedChain,
      })),
    );
  }

  // EVM-compatible chains (Ethereum, Arbitrum, Avalanche, BSC, Optimism, Polygon, Base, zkSync)
  const evmAddresses = text.match(/0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/g);
  if (evmAddresses) {
    addresses.push(
      ...evmAddresses
        .filter(
          (address) =>
            !addresses.some(
              (existing) =>
                existing.chain === "sui" &&
                existing.address.startsWith(address),
            ),
        )
        .map((address) => ({
          address,
          chain: "evm" as BirdeyeSupportedChain, // we don't yet know the chain but can assume it's EVM-compatible
        })),
    );
  }

  // Solana addresses (base58 strings)
  const solAddresses = Array.from(text.matchAll(/[1-9A-HJ-NP-Za-km-z]{32,44}/g))
    .filter((match) => {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      return (
        !/[A-Za-z0-9]/.test(text[start - 1] ?? "") &&
        !/[A-Za-z0-9]/.test(text[end] ?? "")
      );
    })
    .map((match) => match[0]);
  if (solAddresses) {
    addresses.push(
      ...solAddresses.map((address) => ({
        address,
        chain: "solana" as BirdeyeSupportedChain,
      })),
    );
  }

  return addresses;
};

// Time extraction and analysis
export const extractTimeframe = (text: string): Timeframe => {
  // First, check for explicit timeframe mentions
  const timeframe = Object.keys(TIMEFRAME_KEYWORDS).find((tf) =>
    text.toLowerCase().includes(tf.toLowerCase()),
  );
  if (timeframe) return timeframe as Timeframe;

  // Check for semantic timeframe hints
  const semanticMap = {
    "short term": "15m",
    "medium term": "1h",
    "long term": "1d",
    intraday: "1h",
    daily: "1d",
    weekly: "1w",
    detailed: "5m",
    quick: "15m",
    overview: "1d",
  } as const;

  for (const [hint, tf] of Object.entries(semanticMap)) {
    if (text.toLowerCase().includes(hint)) {
      return tf as Timeframe;
    }
  }

  // Analyze for time-related words
  if (text.match(/minute|min|minutes/i)) return "15m";
  if (text.match(/hour|hourly|hours/i)) return "1h";
  if (text.match(/day|daily|24h/i)) return "1d";
  if (text.match(/week|weekly/i)) return "1w";

  // Default based on context
  if (text.match(/trade|trades|trading|recent/i)) return "15m";
  if (text.match(/trend|analysis|analyze/i)) return "1h";
  if (text.match(/history|historical|long|performance/i)) return "1d";

  return "1h"; // Default timeframe
};

export const extractTimeRange = (
  text: string,
): { start: number; end: number } => {
  const now = Math.floor(Date.now() / 1000);

  // Check for specific date ranges
  const dateRangeMatch = text.match(
    /from\s+(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/i,
  );
  if (dateRangeMatch) {
    const start = new Date(dateRangeMatch[1]).getTime() / 1000;
    const end = new Date(dateRangeMatch[2]).getTime() / 1000;
    return { start, end };
  }

  // Check for relative time expressions
  const timeRegex = /(\d+)\s*(second|minute|hour|day|week|month)s?\s*ago/i;
  const match = text.match(timeRegex);
  if (match) {
    const amount = Number.parseInt(match[1], 10);
    const unit = match[2].toLowerCase() as TimeUnit;
    const start = now - amount * TIME_UNITS[unit];
    return { start, end: now };
  }

  // Check for semantic time ranges
  const semanticRanges: Record<string, number> = {
    today: TIME_UNITS.day,
    "this week": TIME_UNITS.week,
    "this month": TIME_UNITS.month,
    recent: TIME_UNITS.hour * 4,
    latest: TIME_UNITS.hour,
    "last hour": TIME_UNITS.hour,
    "last day": TIME_UNITS.day,
    "last week": TIME_UNITS.week,
    "last month": TIME_UNITS.month,
  };

  for (const [range, duration] of Object.entries(semanticRanges)) {
    if (text.toLowerCase().includes(range)) {
      return { start: now - duration, end: now };
    }
  }

  // Analyze context for appropriate default range
  if (text.match(/trend|analysis|performance/i)) {
    return { start: now - TIME_UNITS.week, end: now }; // 1 week for analysis
  }
  if (text.match(/trade|trades|trading|recent/i)) {
    return { start: now - TIME_UNITS.day, end: now }; // 1 day for trading
  }
  if (text.match(/history|historical|long term/i)) {
    return { start: now - TIME_UNITS.month, end: now }; // 1 month for history
  }

  // Default to last 24 hours
  return { start: now - TIME_UNITS.day, end: now };
};

export const extractLimit = (text: string): number => {
  // Check for explicit limit mentions
  const limitMatch = text.match(/\b(show|display|get|fetch|limit)\s+(\d+)\b/i);
  if (limitMatch) {
    const limit = Number.parseInt(limitMatch[2], 10);
    return Math.min(Math.max(limit, 1), 100); // Clamp between 1 and 100
  }

  // Check for semantic limit hints
  if (text.match(/\b(all|everything|full|complete)\b/i)) return 100;
  if (text.match(/\b(brief|quick|summary|overview)\b/i)) return 5;
  if (text.match(/\b(detailed|comprehensive)\b/i)) return 50;

  // Default based on context
  if (text.match(/\b(trade|trades|trading)\b/i)) return 10;
  if (text.match(/\b(analysis|analyze|trend)\b/i)) return 24;
  if (text.match(/\b(history|historical)\b/i)) return 50;

  return 10; // Default limit
};

// Formatting helpers
export const formatValue = (value?: number): string => {
  if (!value) return "N/A";
  if (value && value >= 1_000_000_000) {
    return `$${(value / 1_000_000_000).toFixed(2)}B`;
  }
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(2)}K`;
  }
  return `$${value.toFixed(2)}`;
};

export const formatPercentChange = (change?: number): string => {
  if (change === undefined) return "N/A";
  const symbol = change >= 0 ? "↑" : "↓";
  return `${symbol} ${Math.abs(change).toFixed(2)}%`;
};

export const shortenAddress = (address?: string): string => {
  if (!address || address.length <= 12) return address || "Unknown";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

export const formatTimestamp = (timestamp?: number): string => {
  return timestamp ? new Date(timestamp * 1000).toLocaleString() : "N/A";
};

export const formatPrice = (price?: number): string => {
  return price
    ? price < 0.01
      ? price.toExponential(2)
      : price.toFixed(2)
    : "N/A";
};

export const formatJsonScalar = (value: unknown): string => {
  if (value === undefined || value === null || value === "") {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const normalized = String(value).replace(/\s+/g, " ").trim();
  if (/^[A-Za-z0-9._/@:+-]+$/.test(normalized)) {
    return normalized;
  }
  return `"${normalized.replace(/"/g, '\\"')}"`;
};

export const formatJsonTable = (
  label: string,
  rows: Array<Record<string, unknown>>,
  fields: string[],
): string => {
  const indent = label.match(/^\s*/)?.[0] ?? "";
  if (!rows.length) {
    return `${label}[0]: []`;
  }
  const lines = [`${label}[${rows.length}]{${fields.join(",")}}:`];
  for (const row of rows) {
    lines.push(
      `${indent}  - ${fields.map((field) => formatJsonScalar(row[field])).join(",")}`,
    );
  }
  return lines.join("\n");
};

// API helpers
export async function makeApiRequest<T>(
  url: string,
  options: {
    apiKey: string;
    chain?: BirdeyeSupportedChain;
    method?: "GET" | "POST";
    body?: unknown;
  },
): Promise<T> {
  const { apiKey, chain = "solana", method = "GET", body } = options;

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "X-API-KEY": apiKey,
        "x-chain": chain,
        ...(body && { "Content-Type": "application/json" }),
      },
      ...(body && { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new BirdeyeApiError(404, "Resource not found");
      }
      if (response.status === 429) {
        throw new BirdeyeApiError(429, "Rate limit exceeded");
      }
      throw new BirdeyeApiError(
        response.status,
        `HTTP error! status: ${response.status}`,
      );
    }

    const responseJson: T = await response.json();

    return responseJson;
  } catch (error) {
    if (error instanceof BirdeyeApiError) {
      logger.error(`API Error (${error.status}):`, error.message);
    } else {
      logger.error({ error }, "Error making API request:");
    }
    throw error;
  }
}

// Formatting helpers
export const formatTokenInfo = (
  token: TokenResult,
  metadata?: TokenMetadataSingleResponse,
): string => {
  const priceFormatted =
    token.price != null
      ? token.price < 0.01
        ? token.price.toExponential(2)
        : token.price.toFixed(2)
      : "N/A";

  const volume =
    token.volume_24h_usd != null
      ? `$${(token.volume_24h_usd / 1_000_000).toFixed(2)}M`
      : "N/A";

  const liquidity =
    token.liquidity != null
      ? `$${(token.liquidity / 1_000_000).toFixed(2)}M`
      : "N/A";

  const fdv =
    token.fdv != null ? `$${(token.fdv / 1_000_000).toFixed(2)}M` : "N/A";

  const priceChange =
    token.price_change_24h_percent != null
      ? `${token.price_change_24h_percent > 0 ? "+" : ""}${token.price_change_24h_percent.toFixed(2)}%`
      : "N/A";

  const trades = token.trade_24h != null ? token.trade_24h.toString() : "N/A";

  const age = token.creation_time
    ? `${Math.floor((Date.now() - new Date(token.creation_time).getTime()) / (1000 * 60 * 60 * 24))}d`
    : "N/A";

  let output =
    `🪙 ${token.name} @ ${token.symbol}\n` +
    `💰 USD: $${priceFormatted} (${priceChange})\n` +
    `💎 FDV: ${fdv}\n` +
    `💦 MCap: ${token.market_cap ? `$${(token.market_cap / 1_000_000).toFixed(2)}M` : "N/A"}\n` +
    `💦 Liq: ${liquidity}\n` +
    `📊 Vol: ${volume}\n` +
    `🕰️ Age: ${age}\n` +
    `🔄 Trades: ${trades}\n` +
    `🔗 Address: ${token.address}`;

  // Add metadata if available
  if (metadata?.success) {
    const { extensions } = metadata.data;
    const links: string[] = [];

    if (extensions) {
      if (extensions.website) links.push(`🌐 [Website](${extensions.website})`);
      if (extensions.twitter) links.push(`🐦 [Twitter](${extensions.twitter})`);
      if (extensions.discord) links.push(`💬 [Discord](${extensions.discord})`);
      if (extensions.medium) links.push(`📝 [Medium](${extensions.medium})`);
      if (extensions.coingecko_id)
        links.push(
          `🦎 [CoinGecko](https://www.coingecko.com/en/coins/${extensions.coingecko_id})`,
        );
    }

    if (links.length > 0) {
      output += `\n\n📱 Social Links:\n${links.join("\n")}`;
    }
  }

  return output;
};

// Extract symbols from text
export const extractSymbols = (
  text: string,
  // loose mode will try to extract more symbols but may include false positives
  // strict mode will only extract symbols that are clearly formatted as a symbol using $SOL format
  mode: "strict" | "loose" = "loose",
): string[] => {
  if (!text?.matchAll) return [];
  const symbols = new Set<string>();

  // Match patterns
  const patterns =
    mode === "strict"
      ? [
          // $SYMBOL format (case-insensitive due to 'i' flag)
          /\$([A-Z0-9]{2,10})\b/gi,
        ]
      : [
          // $SYMBOL format
          /\$([A-Z0-9]{2,10})\b/gi,
          // After articles (a/an)
          /\b(?:a|an)\s+([A-Z0-9]{2,10})\b/gi,
          // // Standalone caps
          /\b[A-Z0-9]{2,10}\b/g,
          // // Quoted symbols
          /["']([A-Z0-9]{2,10})["']/gi,
          // // Common price patterns
          /\b([A-Z0-9]{2,10})\/USD\b/gi,
          /\b([A-Z0-9]{2,10})-USD\b/gi,
        ];

  // Extract all matches
  patterns.forEach((pattern) => {
    const matches = Array.from(text.matchAll(pattern));
    for (const match of matches) {
      const symbol = (match[1] || match[0]).toUpperCase();
      symbols.add(symbol);
    }
  });

  return Array.from(symbols);
};

export const formatMetadataResponse = (
  data: TokenMetadataSingleResponse,
  chain: BirdeyeSupportedChain,
): string => {
  const tokenData = data.data;
  const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);
  const chainExplorer = (() => {
    switch (chain) {
      case "solana":
        return `https://solscan.io/token/${tokenData.address}`;
      case "ethereum":
        return `https://etherscan.io/token/${tokenData.address}`;
      case "arbitrum":
        return `https://arbiscan.io/token/${tokenData.address}`;
      case "avalanche":
        return `https://snowtrace.io/token/${tokenData.address}`;
      case "bsc":
        return `https://bscscan.com/token/${tokenData.address}`;
      case "optimism":
        return `https://optimistic.etherscan.io/token/${tokenData.address}`;
      case "polygon":
        return `https://polygonscan.com/token/${tokenData.address}`;
      case "base":
        return `https://basescan.org/token/${tokenData.address}`;
      case "zksync":
        return `https://explorer.zksync.io/address/${tokenData.address}`;
      case "sui":
        return `https://suiscan.xyz/mainnet/object/${tokenData.address}`;
      default:
        return null;
    }
  })();

  let response = `Token Metadata for ${tokenData.name} (${tokenData.symbol}) on ${chainName}\n\n`;

  // Basic Information
  response += "📝 Basic Information\n";
  response += `• Name: ${tokenData.name}\n`;
  response += `• Symbol: ${tokenData.symbol}\n`;
  response += `• Address: ${tokenData.address}\n`;
  response += `• Decimals: ${tokenData.decimals}\n`;
  if (chainExplorer) {
    response += `• Explorer: [View on ${chainName} Explorer](${chainExplorer})\n`;
  }

  // Social Links
  response += "\n🔗 Social Links & Extensions\n";
  response += `${formatSocialLinks(tokenData)}\n`;

  // Logo
  if (tokenData.logo_uri) {
    response += "\n🖼️ Logo\n";
    response += tokenData.logo_uri;
  }

  return response;
};

const formatSocialLinks = (
  data: TokenMetadataSingleResponse["data"],
): string => {
  const links: string[] = [];
  const { extensions } = data;

  if (!extensions) {
    return "No social links available";
  }

  if (extensions.website) {
    links.push(`🌐 [Website](${extensions.website})`);
  }
  if (extensions.twitter) {
    links.push(`🐦 [Twitter](${extensions.twitter})`);
  }
  if (extensions.discord) {
    links.push(`💬 [Discord](${extensions.discord})`);
  }
  if (extensions.medium) {
    links.push(`📝 [Medium](${extensions.medium})`);
  }
  if (extensions.coingecko_id) {
    links.push(
      `🦎 [CoinGecko](https://www.coingecko.com/en/coins/${extensions.coingecko_id})`,
    );
  }

  return links.length > 0 ? links.join("\n") : "No social links available";
};

export const waitFor = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const convertToStringParams = (
  params: BirdeyeApiParams,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(params || {})) {
    result[key] = value?.toString() || "";
  }
  return result;
};

export const getTokenResultFromSearchResponse = (
  response: TokenMarketSearchResponse,
): TokenResult[] | undefined => {
  return response.data.items
    .filter((item) => item.type === "token")
    .flatMap((item) => item.result)
    .filter((result): result is TokenResult => result !== undefined);
};
