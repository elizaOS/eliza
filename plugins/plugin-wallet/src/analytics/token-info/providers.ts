// @ts-nocheck — bridges legacy analytics services behind the consolidated TOKEN_INFO registry.
import type { ActionResult, IAgentRuntime } from "@elizaos/core";
import { BirdeyeProvider } from "../birdeye/birdeye";
import { searchBirdeyeTokens } from "../birdeye/search-category";
import { extractAddresses } from "../birdeye/utils";
import type { DexScreenerService } from "../dexscreener/service";
import type {
  DexScreenerBoostedToken,
  DexScreenerPair,
  DexScreenerProfile,
  DexScreenerServiceResponse,
} from "../dexscreener/types";
import type {
  TokenInfoDispatchContext,
  TokenInfoProvider,
} from "./types";

function success(
  text: string,
  data: Record<string, unknown>,
): ActionResult {
  return {
    success: true,
    text,
    data: { actionName: "TOKEN_INFO", ...data },
  };
}

function failure(
  text: string,
  error: string,
  data: Record<string, unknown> = {},
): ActionResult {
  return {
    success: false,
    text,
    error,
    data: { actionName: "TOKEN_INFO", ...data },
  };
}

async function emit(
  context: TokenInfoDispatchContext,
  result: ActionResult,
): Promise<ActionResult> {
  await context.callback?.({
    text: result.text ?? "",
    actions: ["TOKEN_INFO"],
    data: result.data,
  });
  return result;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getDexScreenerService(
  runtime: IAgentRuntime,
): DexScreenerService | null {
  const service = runtime.getService(
    "dexscreener",
  ) as DexScreenerService | null;
  return service && typeof service.search === "function" ? service : null;
}

function topPairs(
  service: DexScreenerService,
  pairs: readonly DexScreenerPair[],
  limit = 5,
): string {
  return pairs
    .slice(0, limit)
    .map((pair, index) => {
      const price = service.formatPrice(pair.priceUsd || pair.priceNative);
      const volume = pair.volume?.h24
        ? service.formatUsdValue(pair.volume.h24)
        : "n/a";
      const liquidity = pair.liquidity?.usd
        ? service.formatUsdValue(pair.liquidity.usd)
        : "n/a";
      return `${index + 1}. ${pair.baseToken.symbol}/${pair.quoteToken.symbol} on ${pair.dexId} (${pair.chainId}) - price ${price}, volume24h ${volume}, liquidity ${liquidity}`;
    })
    .join("\n");
}

function requireDexResult<T>(
  result: DexScreenerServiceResponse<T>,
  fallbackError: string,
): T {
  if (!result.success || !result.data) {
    throw new Error(String(result.error ?? fallbackError));
  }
  return result.data;
}

async function executeDexScreener(
  context: TokenInfoDispatchContext,
): Promise<ActionResult> {
  const service = getDexScreenerService(context.runtime);
  if (!service) {
    return emit(
      context,
      failure("DexScreener service is not available.", "SERVICE_UNAVAILABLE", {
        target: "dexscreener",
      }),
    );
  }

  const { params } = context;
  try {
    switch (params.subaction) {
      case "search": {
        const query = params.query?.trim();
        if (!query) {
          return emit(
            context,
            failure("Provide query for token search.", "MISSING_QUERY"),
          );
        }
        const pairs = requireDexResult(
          await service.search({ query }),
          "DEXSCREENER_SEARCH_FAILED",
        );
        return emit(
          context,
          success(`Token search results for "${query}":\n${topPairs(service, pairs)}`, {
            target: "dexscreener",
            subaction: "search",
            query,
            pairs: pairs.slice(0, 10),
          }),
        );
      }
      case "token": {
        const tokenAddress = params.tokenAddress ?? params.address;
        if (!tokenAddress) {
          return emit(
            context,
            failure("Provide tokenAddress or address.", "MISSING_TOKEN_ADDRESS"),
          );
        }
        const pairs = requireDexResult(
          await service.getTokenPairs({ tokenAddress }),
          "DEXSCREENER_TOKEN_FAILED",
        );
        if (pairs.length === 0) {
          return emit(
            context,
            failure(`No pairs found for token ${tokenAddress}.`, "NO_PAIRS", {
              target: "dexscreener",
              tokenAddress,
            }),
          );
        }
        const mainPair = pairs.reduce((prev, curr) =>
          (curr.liquidity?.usd || 0) > (prev.liquidity?.usd || 0) ? curr : prev,
        );
        const text = [
          `${mainPair.baseToken.name} (${mainPair.baseToken.symbol})`,
          `Address: ${mainPair.baseToken.address}`,
          `Price: ${service.formatPrice(mainPair.priceUsd || mainPair.priceNative)}`,
          `24h change: ${service.formatPriceChange(mainPair.priceChange?.h24 ?? 0)}`,
          `24h volume: ${service.formatUsdValue(mainPair.volume?.h24 ?? 0)}`,
          `Top pairs:\n${topPairs(service, pairs, 3)}`,
        ].join("\n");
        return emit(
          context,
          success(text, {
            target: "dexscreener",
            subaction: "token",
            tokenAddress,
            pairs,
          }),
        );
      }
      case "trending": {
        const timeframe = params.timeframe ?? "24h";
        const limit = Math.min(25, Math.max(1, params.limit ?? 10));
        const pairs = requireDexResult(
          await service.getTrending({ timeframe, limit }),
          "DEXSCREENER_TRENDING_FAILED",
        );
        return emit(
          context,
          success(`Trending tokens (${timeframe}):\n${topPairs(service, pairs, limit)}`, {
            target: "dexscreener",
            subaction: "trending",
            timeframe,
            pairs,
          }),
        );
      }
      case "new-pairs": {
        const limit = Math.min(25, Math.max(1, params.limit ?? 10));
        const pairs = requireDexResult(
          await service.getNewPairs({ chain: params.chain, limit }),
          "DEXSCREENER_NEW_PAIRS_FAILED",
        );
        return emit(
          context,
          success(
            `New trading pairs${params.chain ? ` on ${params.chain}` : ""}:\n${topPairs(service, pairs, limit)}`,
            {
              target: "dexscreener",
              subaction: "new-pairs",
              chain: params.chain,
              pairs,
            },
          ),
        );
      }
      case "chain-pairs": {
        if (!params.chain) {
          return emit(
            context,
            failure("Provide chain for chain-pairs.", "MISSING_CHAIN"),
          );
        }
        const limit = Math.min(25, Math.max(1, params.limit ?? 10));
        const sortBy = params.sortBy ?? "volume";
        const pairs = requireDexResult(
          await service.getPairsByChain({ chain: params.chain, sortBy, limit }),
          "DEXSCREENER_CHAIN_PAIRS_FAILED",
        );
        return emit(
          context,
          success(
            `Top ${params.chain} pairs by ${sortBy}:\n${topPairs(service, pairs, limit)}`,
            {
              target: "dexscreener",
              subaction: "chain-pairs",
              chain: params.chain,
              sortBy,
              pairs,
            },
          ),
        );
      }
      case "boosted": {
        const result: DexScreenerServiceResponse<DexScreenerBoostedToken[]> =
          params.top
            ? await service.getTopBoostedTokens()
            : await service.getLatestBoostedTokens();
        const tokens = requireDexResult(result, "DEXSCREENER_BOOSTED_FAILED");
        const text = tokens
          .slice(0, Math.min(10, params.limit ?? 10))
          .map(
            (token, index) =>
              `${index + 1}. ${token.tokenAddress} on ${token.chainId} - boost ${token.amount}, total ${token.totalAmount}`,
          )
          .join("\n");
        return emit(
          context,
          success(`${params.top ? "Top" : "Latest"} boosted tokens:\n${text}`, {
            target: "dexscreener",
            subaction: "boosted",
            tokens,
          }),
        );
      }
      case "profiles": {
        const result: DexScreenerServiceResponse<DexScreenerProfile[]> =
          await service.getLatestTokenProfiles();
        const profiles = requireDexResult(
          result,
          "DEXSCREENER_PROFILES_FAILED",
        );
        const text = profiles
          .slice(0, Math.min(10, params.limit ?? 10))
          .map(
            (profile, index) =>
              `${index + 1}. ${profile.tokenAddress} on ${profile.chainId}${profile.description ? ` - ${profile.description}` : ""}`,
          )
          .join("\n");
        return emit(
          context,
          success(`Latest token profiles:\n${text}`, {
            target: "dexscreener",
            subaction: "profiles",
            profiles,
          }),
        );
      }
      case "wallet":
        return emit(
          context,
          failure("DexScreener does not support wallet lookup.", "UNSUPPORTED_SUBACTION", {
            target: "dexscreener",
          }),
        );
    }
  } catch (error) {
    return emit(
      context,
      failure(describeError(error), describeError(error), {
        target: "dexscreener",
        subaction: params.subaction,
      }),
    );
  }
}

function formatBirdeyeWallet(result: any, address: string): string {
  const tokens = result?.data?.items?.slice(0, 10) ?? [];
  const totalValue =
    typeof result?.data?.totalUsd === "number"
      ? result.data.totalUsd
      : tokens.reduce((sum: number, token: any) => sum + (token.valueUsd || 0), 0);
  const holdings = tokens
    .map(
      (token: any) =>
        `- ${String(token.symbol ?? "TOKEN").toUpperCase()}: $${Number(token.valueUsd ?? 0).toLocaleString()} (${token.uiAmount ?? "n/a"})`,
    )
    .join("\n");
  return `Wallet ${address}\nTotal value: $${Number(totalValue ?? 0).toLocaleString()}\nTop holdings:\n${holdings}`;
}

async function executeBirdeye(
  context: TokenInfoDispatchContext,
): Promise<ActionResult> {
  const { params } = context;
  try {
    if (params.subaction === "search" || params.subaction === "token") {
      const query = params.query ?? params.tokenAddress ?? params.address;
      if (!query) {
        return emit(
          context,
          failure("Provide query or tokenAddress for Birdeye token lookup.", "MISSING_QUERY"),
        );
      }
      const mode =
        params.kind === "token-address" || /^0x[a-fA-F0-9]{40}$/.test(query)
          ? "address"
          : "symbol";
      const result = await searchBirdeyeTokens(context.runtime, { query, mode });
      return emit(
        context,
        success(result.text, {
          target: "birdeye",
          subaction: params.subaction,
          query,
          result,
        }),
      );
    }

    if (params.subaction === "wallet") {
      const query = params.query ?? params.address;
      if (!query) {
        return emit(
          context,
          failure("Provide wallet address for Birdeye wallet lookup.", "MISSING_WALLET"),
        );
      }
      const addresses = extractAddresses(query);
      if (addresses.length === 0) {
        return emit(
          context,
          failure("No wallet address found in query.", "MISSING_WALLET"),
        );
      }
      const provider = new BirdeyeProvider(context.runtime);
      const results = await Promise.all(
        addresses.map(async ({ address, chain: addressChain }) => {
          const chain = addressChain === "evm" ? "ethereum" : addressChain;
          return {
            address,
            chain,
            result: await provider.fetchWalletPortfolio(
              { wallet: address },
              { headers: { chain } },
            ),
          };
        }),
      );
      return emit(
        context,
        success(
          results
            .map(({ address, result }) => formatBirdeyeWallet(result, address))
            .join("\n\n"),
          {
            target: "birdeye",
            subaction: "wallet",
            results,
          },
        ),
      );
    }

    return emit(
      context,
      failure(`Birdeye does not support ${params.subaction}.`, "UNSUPPORTED_SUBACTION", {
        target: "birdeye",
      }),
    );
  } catch (error) {
    return emit(
      context,
      failure(describeError(error), describeError(error), {
        target: "birdeye",
        subaction: params.subaction,
      }),
    );
  }
}

function coingeckoHeaders(runtime: IAgentRuntime): Record<string, string> {
  const proKey = runtime.getSetting("COINGECKO_PRO_API_KEY");
  if (typeof proKey === "string" && proKey.trim()) {
    return { "x-cg-pro-api-key": proKey.trim() };
  }
  const demoKey =
    runtime.getSetting("COINGECKO_API_KEY") ??
    runtime.getSetting("COINGECKO_DEMO_API_KEY");
  if (typeof demoKey === "string" && demoKey.trim()) {
    return { "x-cg-demo-api-key": demoKey.trim() };
  }
  return {};
}

function coingeckoBaseUrl(runtime: IAgentRuntime): string {
  const explicit = runtime.getSetting("COINGECKO_API_URL");
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim().replace(/\/$/, "");
  }
  return runtime.getSetting("COINGECKO_PRO_API_KEY")
    ? "https://pro-api.coingecko.com/api/v3"
    : "https://api.coingecko.com/api/v3";
}

async function fetchCoingecko<T>(
  runtime: IAgentRuntime,
  path: string,
): Promise<T> {
  const response = await fetch(`${coingeckoBaseUrl(runtime)}${path}`, {
    headers: {
      accept: "application/json",
      ...coingeckoHeaders(runtime),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json().catch(() => null)) as T;
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: unknown }).error)
        : `CoinGecko request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

const COINGECKO_PLATFORM_ALIASES: Record<string, string> = {
  eth: "ethereum",
  ethereum: "ethereum",
  mainnet: "ethereum",
  base: "base",
  bsc: "binance-smart-chain",
  binance: "binance-smart-chain",
  polygon: "polygon-pos",
  matic: "polygon-pos",
  arbitrum: "arbitrum-one",
  optimism: "optimistic-ethereum",
  avalanche: "avalanche",
  avax: "avalanche",
  solana: "solana",
};

async function executeCoingecko(
  context: TokenInfoDispatchContext,
): Promise<ActionResult> {
  const { params, runtime } = context;
  try {
    if (params.subaction === "search") {
      const query = params.query;
      if (!query) {
        return emit(context, failure("Provide query for CoinGecko search.", "MISSING_QUERY"));
      }
      const result = await fetchCoingecko<{
        coins?: Array<{
          id: string;
          name: string;
          symbol: string;
          market_cap_rank?: number;
        }>;
      }>(runtime, `/search?query=${encodeURIComponent(query)}`);
      const coins = (result.coins ?? []).slice(0, params.limit ?? 10);
      const text = coins
        .map(
          (coin, index) =>
            `${index + 1}. ${coin.name} (${coin.symbol.toUpperCase()}) - id ${coin.id}${coin.market_cap_rank ? `, rank ${coin.market_cap_rank}` : ""}`,
        )
        .join("\n");
      return emit(
        context,
        success(`CoinGecko search results for "${query}":\n${text}`, {
          target: "coingecko",
          subaction: "search",
          query,
          coins,
        }),
      );
    }

    if (params.subaction === "token") {
      const id = params.id ?? params.query;
      const address = params.tokenAddress ?? params.address;
      let path: string;
      if (address && params.chain) {
        const platform = COINGECKO_PLATFORM_ALIASES[params.chain.toLowerCase()] ?? params.chain;
        path = `/coins/${encodeURIComponent(platform)}/contract/${encodeURIComponent(address)}`;
      } else if (id) {
        path = `/coins/${encodeURIComponent(id)}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`;
      } else {
        return emit(
          context,
          failure("Provide CoinGecko coin id/query, or address with chain.", "MISSING_TOKEN"),
        );
      }
      const coin = await fetchCoingecko<any>(runtime, path);
      const market = coin.market_data ?? {};
      const text = [
        `${coin.name} (${String(coin.symbol ?? "").toUpperCase()})`,
        `CoinGecko id: ${coin.id}`,
        `Price: $${market.current_price?.usd ?? "n/a"}`,
        `Market cap: $${market.market_cap?.usd ?? "n/a"}`,
        `24h volume: $${market.total_volume?.usd ?? "n/a"}`,
        `24h change: ${market.price_change_percentage_24h ?? "n/a"}%`,
      ].join("\n");
      return emit(
        context,
        success(text, {
          target: "coingecko",
          subaction: "token",
          coin,
        }),
      );
    }

    if (params.subaction === "trending") {
      const result = await fetchCoingecko<{
        coins?: Array<{
          item?: {
            id: string;
            name: string;
            symbol: string;
            market_cap_rank?: number;
          };
        }>;
      }>(runtime, "/search/trending");
      const coins = (result.coins ?? [])
        .map((entry) => entry.item)
        .filter(Boolean)
        .slice(0, params.limit ?? 10);
      const text = coins
        .map(
          (coin, index) =>
            `${index + 1}. ${coin.name} (${coin.symbol.toUpperCase()}) - id ${coin.id}${coin.market_cap_rank ? `, rank ${coin.market_cap_rank}` : ""}`,
        )
        .join("\n");
      return emit(
        context,
        success(`CoinGecko trending coins:\n${text}`, {
          target: "coingecko",
          subaction: "trending",
          coins,
        }),
      );
    }

    return emit(
      context,
      failure(`CoinGecko does not support ${params.subaction}.`, "UNSUPPORTED_SUBACTION", {
        target: "coingecko",
      }),
    );
  } catch (error) {
    return emit(
      context,
      failure(describeError(error), describeError(error), {
        target: "coingecko",
        subaction: params.subaction,
      }),
    );
  }
}

export function createDexScreenerTokenInfoProvider(): TokenInfoProvider {
  return {
    name: "dexscreener",
    aliases: ["dex", "dex-screener"],
    supportedSubactions: [
      "search",
      "token",
      "trending",
      "new-pairs",
      "chain-pairs",
      "boosted",
      "profiles",
    ],
    description: "DEX pair, boosted-token, and token profile analytics.",
    execute: executeDexScreener,
  };
}

export function createBirdeyeTokenInfoProvider(): TokenInfoProvider {
  return {
    name: "birdeye",
    aliases: ["bird-eye"],
    supportedSubactions: ["search", "token", "wallet"],
    description: "Birdeye token search and wallet portfolio lookup.",
    execute: executeBirdeye,
  };
}

export function createCoinGeckoTokenInfoProvider(): TokenInfoProvider {
  return {
    name: "coingecko",
    aliases: ["coin-gecko", "gecko"],
    supportedSubactions: ["search", "token", "trending"],
    description: "CoinGecko coin search, metadata, and broad market data.",
    execute: executeCoingecko,
  };
}
