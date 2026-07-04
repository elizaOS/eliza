/**
 * Wallet market-overview domain logic.
 *
 * Pure, platform-free helpers shared by the Eliza Cloud market-preview service
 * (`@elizaos/cloud-shared` `market-preview.ts`) and the local-mode iOS agent
 * kernel fallback (`@elizaos/ui` `ios-local-agent-kernel.ts`). Both consume
 * the same CoinGecko provider metadata, stablecoin filters, market mapping, and
 * mover-ranking rules from here so the two copies cannot drift.
 *
 * No node/browser/cloud-only dependencies: raw data in, typed domain objects
 * out. Fetching, caching, and response wrapping stay at each call site.
 */
import type {
  WalletMarketMover,
  WalletMarketOverviewSource,
  WalletMarketPriceSnapshot,
} from "@elizaos/contracts";
import { asRecord } from "../type-guards.js";

/** Number of top-market-cap rows requested from CoinGecko. */
export const COINGECKO_MARKET_LIMIT = 80;

/** Coins surfaced as fixed price snapshots (never as movers). */
export const MARKET_PRICE_IDS = ["bitcoin", "ethereum", "solana"] as const;
export const MARKET_PRICE_ID_SET: ReadonlySet<string> = new Set(
  MARKET_PRICE_IDS,
);

/** CoinGecko ids of assets excluded from mover ranking (stablecoins). */
export const STABLE_ASSET_IDS: ReadonlySet<string> = new Set([
  "tether",
  "usd-coin",
  "binance-usd",
  "first-digital-usd",
  "dai",
  "ethena-usde",
  "true-usd",
  "usds",
]);

/** Ticker symbols of assets excluded from mover ranking (stablecoins). */
export const STABLE_ASSET_SYMBOLS: ReadonlySet<string> = new Set([
  "usdt",
  "usdc",
  "busd",
  "fdusd",
  "dai",
  "usde",
  "tusd",
  "usds",
]);

type MarketProvider = Pick<
  WalletMarketOverviewSource,
  "providerId" | "providerName" | "providerUrl"
>;

/** CoinGecko provider identity for price + mover sources. */
export const COINGECKO_MARKET_PROVIDER = {
  providerId: "coingecko",
  providerName: "CoinGecko",
  providerUrl: "https://www.coingecko.com/",
} as const satisfies MarketProvider;

/** Polymarket provider identity for the predictions source. */
export const POLYMARKET_MARKET_PROVIDER = {
  providerId: "polymarket",
  providerName: "Polymarket",
  providerUrl: "https://polymarket.com/",
} as const satisfies MarketProvider;

/** Normalized CoinGecko `/coins/markets` row used to build the overview. */
export interface CoinGeckoMarketRecord {
  id: string;
  symbol: string;
  name: string;
  currentPriceUsd: number;
  change24hPct: number;
  marketCapRank: number | null;
  imageUrl: string | null;
}

function coerceString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function coerceInteger(value: unknown): number | null {
  const parsed = coerceNumber(value);
  if (parsed === null) return null;
  return Number.isInteger(parsed) ? parsed : Math.round(parsed);
}

/** Build the CoinGecko `/coins/markets` request URL (USD, 24h change). */
export function buildCoinGeckoMarketsUrl(): URL {
  const url = new URL("https://api.coingecko.com/api/v3/coins/markets");
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("order", "market_cap_desc");
  url.searchParams.set("per_page", String(COINGECKO_MARKET_LIMIT));
  url.searchParams.set("page", "1");
  url.searchParams.set("price_change_percentage", "24h");
  return url;
}

/** Map one raw CoinGecko row to a normalized record, or null if incomplete. */
export function mapCoinGeckoMarket(
  input: unknown,
): CoinGeckoMarketRecord | null {
  const record = asRecord(input);
  if (!record) return null;

  const id = coerceString(record.id);
  const symbol = coerceString(record.symbol);
  const name = coerceString(record.name);
  const currentPriceUsd = coerceNumber(record.current_price);
  const change24hPct = coerceNumber(record.price_change_percentage_24h);

  if (
    !id ||
    !symbol ||
    !name ||
    currentPriceUsd === null ||
    change24hPct === null
  ) {
    return null;
  }

  return {
    id,
    symbol: symbol.toUpperCase(),
    name,
    currentPriceUsd,
    change24hPct,
    marketCapRank: coerceInteger(record.market_cap_rank),
    imageUrl: coerceString(record.image),
  };
}

/** Parse a raw CoinGecko `/coins/markets` payload into normalized records. */
export function parseCoinGeckoMarkets(
  payload: unknown,
): CoinGeckoMarketRecord[] {
  if (!Array.isArray(payload)) {
    throw new Error("CoinGecko payload was not an array");
  }
  return payload
    .map(mapCoinGeckoMarket)
    .filter((market): market is CoinGeckoMarketRecord => market !== null);
}

/** Whether a market is a stablecoin (excluded from mover ranking). */
export function isStableAsset(market: CoinGeckoMarketRecord): boolean {
  return (
    STABLE_ASSET_IDS.has(market.id.toLowerCase()) ||
    STABLE_ASSET_SYMBOLS.has(market.symbol.toLowerCase())
  );
}

/** Fixed price snapshots for the tracked `MARKET_PRICE_IDS`, in order. */
export function buildMarketPriceSnapshots(
  markets: CoinGeckoMarketRecord[],
): WalletMarketPriceSnapshot[] {
  const byId = new Map(markets.map((market) => [market.id, market]));
  return MARKET_PRICE_IDS.reduce<WalletMarketPriceSnapshot[]>((items, id) => {
    const market = byId.get(id);
    if (!market) return items;

    items.push({
      id: market.id,
      symbol: market.symbol,
      name: market.name,
      priceUsd: market.currentPriceUsd,
      change24hPct: market.change24hPct,
      imageUrl: market.imageUrl,
    });

    return items;
  }, []);
}

/**
 * Top movers by absolute 24h change: exclude tracked price coins and
 * stablecoins, cap at market-cap rank 200, take the six largest movers.
 */
export function buildMarketMovers(
  markets: CoinGeckoMarketRecord[],
): WalletMarketMover[] {
  return markets
    .filter((market) => !MARKET_PRICE_ID_SET.has(market.id))
    .filter((market) => !isStableAsset(market))
    .filter(
      (market) => market.marketCapRank === null || market.marketCapRank <= 200,
    )
    .sort(
      (left, right) =>
        Math.abs(right.change24hPct) - Math.abs(left.change24hPct),
    )
    .slice(0, 6)
    .map((market) => ({
      id: market.id,
      symbol: market.symbol,
      name: market.name,
      priceUsd: market.currentPriceUsd,
      change24hPct: market.change24hPct,
      marketCapRank: market.marketCapRank,
      imageUrl: market.imageUrl,
    }));
}
