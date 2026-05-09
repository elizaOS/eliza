// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import type { IAgentRuntime, SearchCategoryRegistration } from "@elizaos/core";
import { BirdeyeProvider } from "./birdeye";
import { BIRDEYE_SERVICE_NAME } from "./constants";
import type {
  TokenMarketDataResponse,
  TokenOverviewResponse,
  TokenSecurityResponse,
  TokenTradeDataSingleResponse,
} from "./types/api/token";
import type { BaseAddress } from "./types/shared";
import {
  extractAddresses,
  extractSymbols,
  formatJsonScalar,
  formatJsonTable,
  formatPercentChange,
  formatPrice,
  formatValue,
} from "./utils";

const BIRDEYE_CHAIN_OPTIONS = [
  { label: "All", value: "all" },
  { label: "Solana", value: "solana" },
  { label: "Ethereum", value: "ethereum" },
  { label: "Arbitrum", value: "arbitrum" },
  { label: "Avalanche", value: "avalanche" },
  { label: "BSC", value: "bsc" },
  { label: "Optimism", value: "optimism" },
  { label: "Polygon", value: "polygon" },
  { label: "Base", value: "base" },
  { label: "zkSync", value: "zksync" },
  { label: "Sui", value: "sui" },
];

const BIRDEYE_SORT_OPTIONS = [
  { label: "FDV", value: "fdv" },
  { label: "Market cap", value: "marketcap" },
  { label: "Liquidity", value: "liquidity" },
  { label: "Price", value: "price" },
  { label: "24h price change", value: "price_change_24h_percent" },
  { label: "24h trades", value: "trade_24h" },
  { label: "24h buys", value: "buy_24h" },
  { label: "24h sells", value: "sell_24h" },
  { label: "24h unique wallets", value: "unique_wallet_24h" },
  { label: "Last trade time", value: "last_trade_unix_time" },
  { label: "24h USD volume", value: "volume_24h_usd" },
];

const BIRDEYE_TOKEN_SEARCH_MODES = [
  { label: "Auto", value: "auto" },
  { label: "Symbol", value: "symbol" },
  { label: "Address", value: "address" },
];

const DEFAULT_LIMIT = 5;

export const BIRDEYE_TOKEN_SEARCH_CATEGORY: SearchCategoryRegistration = {
  category: "birdeye_tokens",
  label: "Birdeye token intel",
  description:
    "Search Birdeye token intelligence by symbol or contract address.",
  contexts: ["wallet", "knowledge"],
  filters: [
    {
      name: "mode",
      label: "Mode",
      description:
        "Use symbol for ticker search, address for contract lookup, or auto to infer from the query.",
      type: "enum",
      default: "auto",
      options: BIRDEYE_TOKEN_SEARCH_MODES,
    },
    {
      name: "chain",
      label: "Chain",
      description:
        "Birdeye chain scope. Address mode uses ethereum for EVM addresses when no explicit chain is supplied.",
      type: "enum",
      default: "all",
      options: BIRDEYE_CHAIN_OPTIONS,
    },
    {
      name: "target",
      label: "Target",
      description: "Birdeye search target for symbol mode.",
      type: "enum",
      default: "token",
      options: [
        { label: "Token", value: "token" },
        { label: "Market", value: "market" },
        { label: "All", value: "all" },
      ],
    },
    {
      name: "sort_by",
      label: "Sort by",
      type: "enum",
      default: "volume_24h_usd",
      options: BIRDEYE_SORT_OPTIONS,
    },
    {
      name: "sort_type",
      label: "Sort type",
      type: "enum",
      default: "desc",
      options: [
        { label: "Ascending", value: "asc" },
        { label: "Descending", value: "desc" },
      ],
    },
    {
      name: "verify_token",
      label: "Verified only",
      description: "Restrict symbol results to verified tokens.",
      type: "boolean",
    },
    {
      name: "markets",
      label: "Markets",
      description: "Comma-separated market sources for symbol mode.",
      type: "string",
    },
    {
      name: "includeSecurity",
      label: "Include security",
      description: "Include contract security details in address mode.",
      type: "boolean",
      default: true,
    },
    {
      name: "includeTradeData",
      label: "Include trade data",
      description: "Include holder and 24h trading details in address mode.",
      type: "boolean",
      default: true,
    },
    {
      name: "includeMarketData",
      label: "Include market data",
      description: "Include token market data in address mode.",
      type: "boolean",
      default: true,
    },
  ],
  resultSchemaSummary:
    "BirdeyeTokenSearchResult with mode, query, resultCount, and results. Symbol results include matching tokens; address results include overview, market, security, and trade data.",
  capabilities: [
    "tokens",
    "symbols",
    "addresses",
    "market-data",
    "security",
    "trade-data",
  ],
  source: "plugin:wallet:birdeye",
  serviceType: BIRDEYE_SERVICE_NAME,
};

export const BIRDEYE_SEARCH_CATEGORIES = [
  BIRDEYE_TOKEN_SEARCH_CATEGORY,
] as const;

export interface BirdeyeSearchCategoryOptions {
  enabled?: boolean;
  disabledReason?: string;
}

export type BirdeyeTokenSearchMode = "auto" | "symbol" | "address";

export interface BirdeyeTokenSearchRequest {
  query: string;
  mode?: BirdeyeTokenSearchMode;
  filters?: Record<string, unknown>;
  limit?: number;
}

type BirdeyeTokenAddressSearchResult = {
  address: BaseAddress;
  chain: string;
  overview?: TokenOverviewResponse;
  marketData?: TokenMarketDataResponse;
  security?: TokenSecurityResponse;
  tradeData?: TokenTradeDataSingleResponse;
};

type BirdeyeTokenSymbolSearchResult = {
  symbol: string;
  tokens: unknown[];
};

type BirdeyeTokenSearchProvider = Pick<
  BirdeyeProvider,
  | "fetchSearchTokenMarketData"
  | "fetchTokenOverview"
  | "fetchTokenMarketData"
  | "fetchTokenSecurityByAddress"
  | "fetchTokenTradeDataSingle"
>;

function hasSearchCategory(runtime: IAgentRuntime, category: string): boolean {
  if (typeof runtime.getSearchCategory !== "function") {
    return false;
  }
  try {
    runtime.getSearchCategory(category, { includeDisabled: true });
    return true;
  } catch {
    return false;
  }
}

export function registerBirdeyeSearchCategories(
  runtime: IAgentRuntime,
  options: BirdeyeSearchCategoryOptions = {},
): void {
  if (typeof runtime.registerSearchCategory !== "function") {
    runtime.logger?.warn?.(
      "Birdeye search category registry is unavailable; token search metadata was not registered",
    );
    return;
  }

  const enabled = options.enabled ?? true;
  for (const category of BIRDEYE_SEARCH_CATEGORIES) {
    if (hasSearchCategory(runtime, category.category)) {
      continue;
    }
    runtime.registerSearchCategory({
      ...category,
      enabled,
      disabledReason: enabled ? undefined : options.disabledReason,
    });
  }
}

function normalizeMode(value: unknown): BirdeyeTokenSearchMode {
  const mode = typeof value === "string" ? value.toLowerCase() : "auto";
  return mode === "symbol" || mode === "address" ? mode : "auto";
}

function normalizeLimit(value: unknown): number {
  const limit =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : DEFAULT_LIMIT;
  return Math.max(1, Math.min(25, limit));
}

function filterBool(
  filters: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  return typeof filters[key] === "boolean" ? filters[key] : fallback;
}

function normalizeSymbolQuery(query: string): string[] {
  const strict = extractSymbols(query, "strict");
  if (strict.length > 0) {
    return strict;
  }
  const loose = extractSymbols(query, "loose");
  if (loose.length > 0) {
    return loose;
  }
  const symbol = query.trim().replace(/^\$/, "").toUpperCase();
  return symbol ? [symbol] : [];
}

function inferMode(
  query: string,
  requestedMode: BirdeyeTokenSearchMode,
): Exclude<BirdeyeTokenSearchMode, "auto"> {
  if (requestedMode === "symbol" || requestedMode === "address") {
    return requestedMode;
  }
  return extractAddresses(query).length > 0 ? "address" : "symbol";
}

function chainForAddress(
  address: BaseAddress,
  filters: Record<string, unknown>,
): string {
  const chain = typeof filters.chain === "string" ? filters.chain : "";
  if (chain && chain !== "all") {
    return chain;
  }
  return address.chain === "evm" ? "ethereum" : address.chain;
}

async function searchTokensBySymbol(
  provider: BirdeyeTokenSearchProvider,
  query: string,
  filters: Record<string, unknown>,
  limit: number,
): Promise<BirdeyeTokenSymbolSearchResult[]> {
  const symbols = normalizeSymbolQuery(query);
  const chain = typeof filters.chain === "string" ? filters.chain : "all";
  const target = typeof filters.target === "string" ? filters.target : "token";
  const sortBy =
    typeof filters.sort_by === "string" ? filters.sort_by : "volume_24h_usd";
  const sortType =
    typeof filters.sort_type === "string" ? filters.sort_type : "desc";

  const results = await Promise.all(
    symbols.map(async (symbol) => {
      const response = await provider.fetchSearchTokenMarketData({
        keyword: symbol,
        chain,
        target,
        sort_by: sortBy,
        sort_type: sortType,
        limit,
        verify_token:
          typeof filters.verify_token === "boolean"
            ? filters.verify_token
            : undefined,
        markets:
          typeof filters.markets === "string" ? filters.markets : undefined,
      });
      const tokens = (response?.data?.items ?? [])
        .filter((item) => item.type === "token" && item.result)
        .flatMap((item) => item.result)
        .filter(
          (token) => token?.symbol?.toLowerCase?.() === symbol.toLowerCase(),
        )
        .slice(0, limit);
      return { symbol, tokens };
    }),
  );

  return results;
}

async function searchTokensByAddress(
  provider: BirdeyeTokenSearchProvider,
  query: string,
  filters: Record<string, unknown>,
): Promise<BirdeyeTokenAddressSearchResult[]> {
  const addresses = extractAddresses(query);
  const includeMarketData = filterBool(filters, "includeMarketData", true);
  const includeSecurity = filterBool(filters, "includeSecurity", true);
  const includeTradeData = filterBool(filters, "includeTradeData", true);

  return Promise.all(
    addresses.map(async (address) => {
      const chain = chainForAddress(address, filters);
      const request = { address: address.address };
      const options = { headers: { "x-chain": chain } };
      const [overview, marketData, security, tradeData] = await Promise.all([
        provider.fetchTokenOverview(request, options),
        includeMarketData
          ? provider.fetchTokenMarketData(request, options)
          : Promise.resolve(undefined),
        includeSecurity
          ? provider.fetchTokenSecurityByAddress(request, options)
          : Promise.resolve(undefined),
        includeTradeData
          ? provider.fetchTokenTradeDataSingle(request, options)
          : Promise.resolve(undefined),
      ]);

      return {
        address,
        chain,
        overview,
        marketData,
        security,
        tradeData,
      };
    }),
  );
}

function formatSymbolSearchJson(
  query: string,
  results: BirdeyeTokenSymbolSearchResult[],
): string {
  const rows = results.flatMap((result) =>
    result.tokens.map((token) => ({
      querySymbol: result.symbol,
      symbol: token.symbol?.toUpperCase?.() ?? result.symbol,
      address: token.address,
      network: token.network ?? "unknown",
      price: formatPrice(token.price),
      change24h: formatPercentChange(token.price_change_24h_percent),
      volume24hUsd: formatValue(token.volume_24h_usd),
      marketCap: token.market_cap ? formatValue(token.market_cap) : "N/A",
      fdv: token.fdv ? formatValue(token.fdv) : "N/A",
    })),
  );

  return [
    "birdeye_token_search:",
    "  mode: symbol",
    `  query: ${formatJsonScalar(query)}`,
    `  resultCount: ${rows.length}`,
    formatJsonTable("  results", rows, [
      "querySymbol",
      "symbol",
      "address",
      "network",
      "price",
      "change24h",
      "volume24hUsd",
      "marketCap",
      "fdv",
    ]),
  ]
    .filter(Boolean)
    .join("\n");
}

function formatAddressSearchJson(
  query: string,
  results: BirdeyeTokenAddressSearchResult[],
): string {
  const rows = results.map((result) => ({
    address: result.address.address,
    chain: result.chain,
    name: result.overview?.data?.name ?? "unknown",
    symbol: result.overview?.data?.symbol?.toUpperCase?.() ?? "unknown",
    decimals: result.overview?.data?.decimals ?? "unknown",
    price: formatPrice(
      result.marketData?.data?.price ?? result.overview?.data?.price,
    ),
    liquidity: formatValue(
      result.marketData?.data?.liquidity ?? result.overview?.data?.liquidity,
    ),
    marketCap: formatValue(result.marketData?.data?.marketcap),
    holders: result.tradeData?.data?.holder ?? "unknown",
    change24h: formatPercentChange(
      result.tradeData?.data?.price_change_24h_percent,
    ),
    owner: result.security?.data?.ownerAddress ?? "unknown",
  }));

  return [
    "birdeye_token_search:",
    "  mode: address",
    `  query: ${formatJsonScalar(query)}`,
    `  resultCount: ${rows.length}`,
    formatJsonTable("  results", rows, [
      "address",
      "chain",
      "name",
      "symbol",
      "decimals",
      "price",
      "liquidity",
      "marketCap",
      "holders",
      "change24h",
      "owner",
    ]),
  ]
    .filter(Boolean)
    .join("\n");
}

export async function searchBirdeyeTokens(
  runtime: IAgentRuntime,
  request: BirdeyeTokenSearchRequest,
  provider: BirdeyeTokenSearchProvider = new BirdeyeProvider(runtime),
) {
  const query = String(request.query ?? "").trim();
  const filters = request.filters ?? {};
  const requestedMode = normalizeMode(request.mode ?? filters.mode);
  const mode = inferMode(query, requestedMode);
  const limit = normalizeLimit(request.limit ?? filters.limit);

  if (!query) {
    return {
      query,
      mode,
      resultCount: 0,
      results: [],
      text: "birdeye_token_search:\n  status: error\n  reason: missing_query",
    };
  }

  if (mode === "address") {
    const results = await searchTokensByAddress(provider, query, filters);
    return {
      query,
      mode,
      resultCount: results.length,
      results,
      text: formatAddressSearchJson(query, results),
    };
  }

  const results = await searchTokensBySymbol(provider, query, filters, limit);
  const resultCount = results.reduce(
    (count, result) => count + result.tokens.length,
    0,
  );
  return {
    query,
    mode,
    resultCount,
    results,
    text: formatSymbolSearchJson(query, results),
  };
}
