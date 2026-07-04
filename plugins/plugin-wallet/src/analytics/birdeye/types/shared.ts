/** Chain/address/cache/token shared types used across the Birdeye client and its providers. */
import type { BIRDEYE_SUPPORTED_CHAINS } from "../utils";

export type BirdeyeSupportedChain = (typeof BIRDEYE_SUPPORTED_CHAINS)[number];

export interface BaseAddress {
  type?: "wallet" | "token" | "contract";
  symbol?: string;
  address: string;
  chain: BirdeyeSupportedChain;
}

export interface WalletAddress extends BaseAddress {
  type: "wallet";
}

export interface TokenAddress extends BaseAddress {
  type: "token";
}

export interface ContractAddress extends BaseAddress {
  type: "contract";
}

/** Shape of what's stored in the cache. */
export interface CacheWrapper<T> {
  data: T;
  /** Unix ms timestamp when the entry was set */
  setAt: number;
}

export interface GetCacheTimedOptions {
  /** Max age in milliseconds. If exceeded, treat as a cache miss. */
  notOlderThan?: number;
  /** Timestamp in milliseconds for cache entry. Defaults to Date.now() if not provided. */
  tsInMs?: number;
}

/** Normalized token descriptor merged from a Birdeye data provider response. */
export interface IToken {
  provider: string;
  chain: BirdeyeSupportedChain;
  address: string;
  decimals: number;
  liquidity: number;
  marketcap: number;
  logoURI: string;
  name: string;
  symbol: string;
  volume24hUSD: number;
  rank: number;
  price: number;
  price24hChangePercent: number;
  last_updated: Date;
}

export interface TransactionHistory {
  txHash: string;
  blockTime: Date;
  data: unknown;
}

export interface Portfolio {
  key: string;
  data: unknown;
}
