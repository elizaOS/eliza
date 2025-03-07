import { z } from "zod";

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
	address: z.string().min(1, "Address is required"),
});

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

const SentimentSchema = z.object({
	timeslot: z.string().datetime(),
	createdAt: z.string().datetime(),
	occuringTokens: z.array(
		z.object({
			token: z.string(),
			sentiment: z.number(),
			reason: z.string(),
		}),
	),
	processed: z.boolean(),
	updatedAt: z.string().datetime(),
	text: z.string(),
});

const SentimentArraySchema = z.array(SentimentSchema);

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
		}),
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
export type Token = z.infer<typeof TokenSchema>;
export type TokenArray = z.infer<typeof TokenArraySchema>;
export type TokenRequest = z.infer<typeof TokenRequestSchema>;
export type Tweet = z.infer<typeof TweetSchema>;
export type TweetArray = z.infer<typeof TweetArraySchema>;
export type Sentiment = z.infer<typeof SentimentSchema>;
export type SentimentArray = z.infer<typeof SentimentArraySchema>;
export type Wallet = z.infer<typeof WalletSchema>;
export type BuySignal = z.infer<typeof BuySignalSchema>;
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
