export interface WalletExportRequestBody {
  confirm?: boolean;
  exportToken?: string;
}

export interface WalletExportRejection {
  status: 400 | 401 | 402 | 403 | 429;
  reason: string;
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
