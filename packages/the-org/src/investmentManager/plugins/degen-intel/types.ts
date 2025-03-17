import type { Content } from '@elizaos/core';

/**
 * Represents a type that can be one of four values: "solana", "base", "ethereum", or "L1".
 */
export type TChain = 'solana' | 'base' | 'ethereum' | 'L1';
/**
 * Type representing different data providers.
 * Possible values are "birdeye" and "coinmarketcap".
 */
export type TDataProvider = 'birdeye' | 'coinmarketcap';

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
  provider: TDataProvider;
  chain: TChain;
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
 * Interface for a sentiment token, representing a token with its corresponding sentiment value and reason.
 *
 * @interface
 * @property {string} token - The token string.
 * @property {number} sentiment - The sentiment value corresponding to the token.
 * @property {string} reason - The reason for the sentiment value.
 */
export interface ISentimentToken {
  token: string;
  sentiment: number;
  reason: string;
}

/**
 * Interface representing a sentiment analysis object.
 * @interface
 * @property {Date} timeslot - The date and time of the sentiment analysis.
 * @property {boolean} [processed] - Flag indicating if the sentiment has been processed.
 * @property {string} text - The text content of the sentiment.
 * @property {ISentimentToken[]} occuringTokens - Array of sentiment tokens found in the text.
 */
export interface ISentiment {
  timeslot: Date;
  processed?: boolean;
  text: string;
  occuringTokens: ISentimentToken[];
}

/**
 * Interface representing a data object with a key-value pair.
 * @typedef {object} IData
 * @property {object} data - The data object.
 * @property {string} key - The key associated with the data object.
 */
export interface IData {
  data: object;
  key: string;
}

/**
 * Interface for representing a transaction history object.
 * @interface
 * @property {string} txHash - The hash of the transaction.
 * @property {Date} blockTime - The timestamp of the block containing the transaction.
 * @property {object} data - Additional data associated with the transaction.
 */
export interface ITransactionHistory {
  txHash: string;
  blockTime: Date;
  data: object;
}

/**
 * Represents a job object with an id, name, and data.
 * @typedef {Object} Job
 * @property {string} id - The unique identifier of the job.
 * @property {string} name - The name of the job.
 * @property {any} data - Additional data related to the job.
 */
export type Job = {
  id: string;
  name: string;
  data: any;
};

/**
 * Interface representing a sentiment object.
 * @interface
 * @property {string} timeslot - The timeslot of the sentiment.
 * @property {boolean} processed - Indicates if the sentiment has been processed.
 * @property {string} [text] - The text associated with the sentiment.
 * @property {Array<{ token: string; sentiment: number; reason: string; }>} [occuringTokens] - The array of tokens with their sentiment and reason.
 */
export interface Sentiment {
  timeslot: string;
  processed: boolean;
  text?: string;
  occuringTokens?: Array<{
    token: string;
    sentiment: number;
    reason: string;
  }>;
}

/**
 * Interface representing content from Twitter.
 * Extends the Content interface.
 * @property {string} text - The text content of the tweet.
 * @property {"twitter"} source - The source of the content, always "twitter".
 * @property {string} [url] - Optional URL of the tweet.
 * @property {Object} tweet - Object containing tweet details.
 * @property {string} tweet.username - The username of the tweet author.
 * @property {number} [tweet.likes] - Optional number of likes on the tweet.
 * @property {number} [tweet.retweets] - Optional number of retweets of the tweet.
 */

export interface TwitterContent extends Content {
  text: string;
  source: 'twitter';
  url?: string;
  tweet?: {
    username: string;
    likes?: number;
    retweets?: number;
  };
}
