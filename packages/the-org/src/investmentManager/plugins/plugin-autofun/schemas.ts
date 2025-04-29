import { z } from 'zod';

/**
 * Schema representing a token object
 * @typedef {Object} TokenSchema
 * @property {string} provider The provider of the token
 * @property {number} rank The rank of the token
 * @property {number} __v Version number
 * @property {string} address The token address
 * @property {string} chain The chain the token belongs to
 * @property {string} createdAt The creation date and time of the token
 * @property {number} decimals The number of decimal places for the token
 * @property {string} last_updated The last update date and time of the token
 * @property {number} liquidity The liquidity of the token
 * @property {string} logoURI The URL for the token's logo
 * @property {string} name The name of the token
 * @property {number} price The price of the token
 * @property {number} price24hChangePercent The percentage change in price in the last 24 hours
 * @property {string} symbol The symbol of the token
 * @property {string} updatedAt The update date and time of the token
 * @property {number} volume24hUSD The 24-hour trading volume of the token in USD
 * @property {number} marketcap The market capitalization of the token
 */
const TokenSchema = z.object({
  provider: z.string(),
  rank: z.number(),
  __v: z.number(),
  address: z.string(),
  chain: z.string(),
  createdAt: z.string().datetime(),
  decimals: z.number(),
  last_updated: z.string().datetime(),
  liquidity: z.number(),
  logoURI: z.string().url(),
  name: z.string(),
  price: z.number(),
  price24hChangePercent: z.number(),
  symbol: z.string(),
  updatedAt: z.string().datetime(),
  volume24hUSD: z.number(),
  marketcap: z.number(),
});

const TokenArraySchema = z.array(TokenSchema);

export const TokenRequestSchema = z.object({
  address: z.string().min(1, 'Address is required'),
});

/**
 * Defines the schema for a Tweet object.
 * @typedef {Object} TweetSchema
 * @property {string} _id - The unique identifier of the Tweet.
 * @property {string} id - The identifier of the Tweet.
 * @property {number} __v - The version number of the Tweet.
 * @property {string} createdAt - The date and time when the Tweet was created.
 * @property {number} likes - The number of likes on the Tweet.
 * @property {number} retweets - The number of retweets of the Tweet.
 * @property {string} text - The content of the Tweet.
 * @property {string} timestamp - The date and time when the Tweet was posted.
 * @property {string} updatedAt - The date and time when the Tweet was last updated.
 * @property {string} username - The username of the user who posted the Tweet.
 */

const TweetSchema = z.object({
  _id: z.string(),
  id: z.string(),
  __v: z.number(),
  createdAt: z.string().datetime(),
  likes: z.number(),
  retweets: z.number(),
  text: z.string(),
  timestamp: z.string().datetime(),
  updatedAt: z.string().datetime(),
  username: z.string(),
});

const TweetArraySchema = z.array(TweetSchema);

/**
 * Represents a schema for sentiment analysis data.
 * @typedef {Object} SentimentSchema
 * @property {string} timeslot - The timeslot for the sentiment analysis data.
 * @property {string} createdAt - The creation timestamp of the sentiment analysis data.
 * @property {Object[]} occuringTokens - An array of objects representing tokens with sentiment analysis data.
 * @property {string} occuringTokens.token - The token string.
 * @property {number} occuringTokens.sentiment - The sentiment value for the token.
 * @property {string} occuringTokens.reason - The reason for the sentiment analysis result.
 * @property {boolean} processed - Indicates if the sentiment data has been processed.
 * @property {string} updatedAt - The timestamp when the sentiment analysis data was last updated.
 * @property {string} text - The text content associated with the sentiment analysis data.
 */
const SentimentSchema = z.object({
  timeslot: z.string().datetime(),
  createdAt: z.string().datetime(),
  occuringTokens: z.array(
    z.object({
      token: z.string(),
      sentiment: z.number(),
      reason: z.string(),
    })
  ),
  processed: z.boolean(),
  updatedAt: z.string().datetime(),
  text: z.string(),
});

const SentimentArraySchema = z.array(SentimentSchema);

/**
 * Represents a schema for a wallet object.
 * @type {import('zod').ZodObject<{
 *   wallet: import('zod').ZodString;
 *   totalUsd: import('zod').ZodNumber;
 *   items: import('zod').ZodArray<import('zod').ZodObject<{
 *     address: import('zod').ZodString;
 *     decimals: import('zod').ZodNumber;
 *     balance: import('zod').ZodNumber;
 *     uiAmount: import('zod').ZodNumber;
 *     chainId: import('zod').ZodString;
 *     name: import('zod').ZodString;
 *     symbol: import('zod').ZodString;
 *     icon: import('zod').ZodString.url;
 *     logoURI: import('zod').ZodString.url;
 *     priceUsd: import('zod').ZodNumber;
 *     valueUsd: import('zod').ZodNumber;
 *   }>;
 * }>
 */
const WalletSchema = z.object({
  wallet: z.string(),
  totalUsd: z.number(),
  items: z.array(
    z.object({
      address: z.string(),
      decimals: z.number(),
      balance: z.number(),
      uiAmount: z.number(),
      chainId: z.string(),
      name: z.string(),
      symbol: z.string(),
      icon: z.string().url(),
      logoURI: z.string().url(),
      priceUsd: z.number(),
      valueUsd: z.number(),
    })
  ),
});

const BuySignalSchema = z.object({
  recommended_buy: z.string(),
  recommended_buy_address: z.string(),
  reason: z.string(),
  marketcap: z.number(),
  buy_amount: z.string(),
});

const StatisticsSchema = z.object({
  tweets: z.number(),
  sentiment: z.number(),
  tokens: z.number(),
});

// Type exports for TypeScript
/**
 * Represents a token that corresponds to the inferred type of `TokenSchema`.
 */
export type Token = z.infer<typeof TokenSchema>;
/**
 * Type definition for a TokenArray, inferred from TokenArraySchema.
 */
export type TokenArray = z.infer<typeof TokenArraySchema>;
/**
 * Type definition for a Token Request, based on the TokenRequestSchema.
 */
export type TokenRequest = z.infer<typeof TokenRequestSchema>;
/**
 * Represents a Tweet object derived from the TweetSchema type.
 */

export type Tweet = z.infer<typeof TweetSchema>;
/**
 * Type definition for an array of tweets, inferred from the TweetArraySchema
 */
export type TweetArray = z.infer<typeof TweetArraySchema>;
/**
 * Represents the type of data that is inferred from the SentimentSchema.
 */
export type Sentiment = z.infer<typeof SentimentSchema>;
/**
 * Type definition for an array of sentiments inferred from SentimentArraySchema.
 */
export type SentimentArray = z.infer<typeof SentimentArraySchema>;
/**
 * Type definition for a Wallet object which is inferred from WalletSchema.
 */
export type Wallet = z.infer<typeof WalletSchema>;
/**
 * Represents the inferred type of the `BuySignalSchema`.
 */
export type BuySignal = z.infer<typeof BuySignalSchema>;
/**
 * Type definition for the inferred type of StatisticsSchema
 */
export type Statistics = z.infer<typeof StatisticsSchema>;

export {
  TokenSchema,
  TokenArraySchema,
  TweetSchema,
  TweetArraySchema,
  SentimentSchema,
  SentimentArraySchema,
  WalletSchema,
  BuySignalSchema,
  StatisticsSchema,
};
