// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import type { BIRDEYE_SUPPORTED_CHAINS } from "../utils";

// Types
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

/**
 * Represents a type that can be one of four values: "solana", "base", "ethereum", or "L1".
 */
//export type TChain = 'solana' | 'base' | 'ethereum' | 'L1';
/**
 * Type representing different data providers.
 * Possible values are "birdeye" and "coinmarketcap".
 */
//export type TDataProvider = 'birdeye' | 'coinmarketcap';

// Shape of what's stored in the cache
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

/**
 * Interface representing a token with various properties.
 * @typedef { object } IToken
 * @property { TDataProvider } provider - The data provider of the token.
 * @property { TChain } chain - The blockchain the token belongs to.
 * @property { string } address - The address of the token.
 * @property { number } decimals - The number of decimal places for the token.
 * @property { number } liquidity - The liquidity of the token.
 * @property { number } marketcap - The market cap of the token.
 * @property { string } logoURI - The URI for the token's logo.
 * @property { string } name - The name of the token.
 * @property { string } symbol - The symbol of the token.
 * @property { number } volume24hUSD - The 24-hour trading volume in USD.
 * @property { number } rank - The rank of the token.
 * @property { number } price - The current price of the token.
 * @property { number } price24hChangePercent - The percentage change in price over the last 24 hours.
 * @property { Date } last_updated - The date when the token data was last updated.
 */
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

/**
 * Interface representing a transaction history entry.
 * @property {string} txHash - The hash of the transaction.
 * @property {Date} blockTime - The time when the transaction occurred.
 * @property {any} data - Additional data related to the transaction.
 */
export interface TransactionHistory {
  txHash: string;
  blockTime: Date;
  data: unknown;
}

/**
 * Interface representing a Portfolio object.
 * @typedef {Object} Portfolio
 * @property {string} key - The key associated with the portfolio.
 * @property {any} data - The data contained in the portfolio.
 */
export interface Portfolio {
  key: string;
  data: unknown;
}
