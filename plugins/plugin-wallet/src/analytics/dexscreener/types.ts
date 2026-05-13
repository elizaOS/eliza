// DexScreener API Types

export interface DexScreenerTokenInfo {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
}

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  labels?: string[];
  baseToken: DexScreenerTokenInfo;
  quoteToken: DexScreenerTokenInfo;
  priceNative: string;
  priceUsd?: string;
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  volume: {
    h24: number;
    h6: number;
    h1: number;
    m5: number;
  };
  priceChange: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  liquidity?: {
    usd?: number;
    base: number;
    quote: number;
  };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: { label: string; url: string }[];
    socials?: { type: string; url: string }[];
  };
}

export interface DexScreenerSearchParams {
  query: string;
}

export interface DexScreenerTokenParams {
  tokenAddress: string;
}

export interface DexScreenerPairParams {
  pairAddress: string;
}

export interface DexScreenerTrendingParams {
  timeframe?: "1h" | "6h" | "24h";
  limit?: number;
}

export interface DexScreenerChainParams {
  chain: string;
  sortBy?: "volume" | "liquidity" | "priceChange" | "txns";
  limit?: number;
}

export interface DexScreenerNewPairsParams {
  chain?: string;
  limit?: number;
}

export interface DexScreenerProfile {
  url: string;
  chainId: string;
  tokenAddress: string;
  icon?: string;
  header?: string;
  openGraph?: string;
  description?: string;
  links?: Array<{
    label: string;
    type: string;
    url: string;
  }>;
}

export interface DexScreenerServiceResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface DexScreenerConfig {
  apiUrl?: string;
  rateLimitDelay?: number;
}

export interface DexScreenerBoostedToken {
  url: string;
  chainId: string;
  tokenAddress: string;
  amount: number;
  totalAmount: number;
  icon?: string;
  header?: string;
  description?: string;
  links?: Array<{
    type: string;
    label: string;
    url: string;
  }>;
}

export interface DexScreenerOrder {
  type: "tokenProfile" | "boost" | string;
  status: "processing" | "completed" | "failed" | string;
  paymentTimestamp: number;
}
