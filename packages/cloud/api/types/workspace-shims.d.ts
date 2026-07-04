/**
 * Type-only workspace shims for cloud API typechecking.
 *
 * `tsgo` treats this ambient module as the local `@elizaos/shared` surface when
 * checking the Cloudflare Worker package. Keep these declarations aligned with
 * the real shared exports used through cloud-shared aliases.
 */

declare module "@elizaos/shared" {
  export interface CoinGeckoMarketRecord {
    id: string;
    symbol: string;
    name: string;
    currentPriceUsd: number;
    change24hPct: number;
    marketCapRank: number | null;
    imageUrl: string | null;
  }

  export interface WalletMarketPriceSnapshot {
    id: string;
    symbol: string;
    name: string;
    priceUsd: number;
    change24hPct: number;
    imageUrl: string | null;
  }

  export interface WalletMarketMover {
    id: string;
    symbol: string;
    name: string;
    priceUsd: number;
    change24hPct: number;
    marketCapRank: number | null;
    imageUrl: string | null;
  }

  export interface WalletMarketPrediction {
    id: string;
    slug: string | null;
    question: string;
    highlightedOutcomeLabel: string;
    highlightedOutcomeProbability: number | null;
    volume24hUsd: number;
    totalVolumeUsd: number | null;
    endsAt: string | null;
    imageUrl: string | null;
  }

  export type WalletMarketOverviewProviderId = "coingecko" | "polymarket";

  export interface WalletMarketOverviewSource {
    providerId: WalletMarketOverviewProviderId;
    providerName: string;
    providerUrl: string;
    available: boolean;
    stale: boolean;
    error: string | null;
  }

  export interface WalletMarketOverviewResponse {
    generatedAt: string;
    cacheTtlSeconds: number;
    stale: boolean;
    sources: {
      prices: WalletMarketOverviewSource;
      movers: WalletMarketOverviewSource;
      predictions: WalletMarketOverviewSource;
    };
    prices: WalletMarketPriceSnapshot[];
    movers: WalletMarketMover[];
    predictions: WalletMarketPrediction[];
  }

  export const COINGECKO_MARKET_PROVIDER: {
    providerId: "coingecko";
    providerName: "CoinGecko";
    providerUrl: "https://www.coingecko.com/";
  };

  export const POLYMARKET_MARKET_PROVIDER: {
    providerId: "polymarket";
    providerName: "Polymarket";
    providerUrl: "https://polymarket.com/";
  };

  export function buildCoinGeckoMarketsUrl(): URL;

  export function buildMarketMovers(
    markets: CoinGeckoMarketRecord[],
  ): WalletMarketMover[];

  export function buildMarketPriceSnapshots(
    markets: CoinGeckoMarketRecord[],
  ): WalletMarketPriceSnapshot[];

  export function parseCoinGeckoMarkets(
    payload: unknown,
  ): CoinGeckoMarketRecord[];
}
