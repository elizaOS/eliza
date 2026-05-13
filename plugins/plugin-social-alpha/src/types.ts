import type {
	Content,
	UUID as CoreUUID,
	IAgentRuntime,
	Memory,
	MetadataValue,
} from "@elizaos/core";

// Re-export UUID type for use in other files
/**
 * Represents a universally unique identifier (UUID).
 */
export type UUID = CoreUUID;

/**
 * Represents a type where certain properties from the original type T are optional.
 * @template T - The original type
 * @template K - The keys of the properties that should be optional
 * @typedef {Omit<T, K> & Partial<Pick<T, K>>} Optional
 */
export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
/**
 * Creates a new type by transforming each key in the provided type `type` into a property with the same key and value.
 * @template type The type to make pretty.
 * @typedef {Object} Pretty
 * @property {keyof type} key The key from the original type
 * @property {type[key]} value The value associated with the key from the original type
 * @augments unknown
 */
export type Pretty<type> = { [key in keyof type]: type[key] } & unknown;

/**
 * Type that extracts variables enclosed in double curly braces from a given string.
 *
 * @template T The input string type
 * @typedef {T} ExtractVariables
 * @param {T} T The input string to extract variables from
 * @returns {Var} The variables extracted from the input string
 */
type ExtractVariables<T extends string> =
	T extends `${infer Start}{{${infer Var}}}${infer Rest}`
		? Var | ExtractVariables<Rest>
		: never;

/**
 * Represents a type that defines template variables for a given string type.
 *
 * @template T - The string type for which template variables are defined.
 * @typedef TemplateVariables
 * @type {Pretty<{ [K in ExtractVariables<T>]: string; }>}
 */
export type TemplateVariables<T extends string> = Pretty<{
	[K in ExtractVariables<T>]: string;
}>;

/** Recursive JSON-compatible value used in metadata records. */
export type MetadataJsonValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| MetadataJsonValue[]
	| { [key: string]: MetadataJsonValue };

/** Record type for token metadata (supports nested objects like security info). */
export type TokenMetadataRecord = Record<string, MetadataJsonValue>;

/**
 * Represents a value that can be stored in a SQLite database, which can be a string, number, or null.
 */
type SQLiteValue = string | number | null;

/**
 * Type utility for converting TypeScript types to SQLite column types.
 *
 * @template T - The TypeScript type to convert.
 * @param {T} - The value to convert.
 * @returns {ToSQLiteType<T>} - The SQLite column type equivalent of the input type.
 */
type ToSQLiteType<T> = T extends boolean
	? number
	: T extends Date
		? string
		: T extends bigint
			? string
			: T extends Array<unknown>
				? string
				: T extends object
					? string
					: T extends SQLiteValue
						? T
						: never;

/**
 * Converts a generic record type to a SQLite record type, where each property value is converted to a SQLite type.
 *
 * @template T - The generic record type to be converted to a SQLite record type.
 * @typedef ToSQLiteRecord
 * @type {object}
 */
export type ToSQLiteRecord<T extends object> = {
	[K in keyof T]: ToSQLiteType<T[K]>;
};

/**
 * Represents a type which is used to define a single row in the database table for RecommenderMetrics.
 */
export type RecommenderMetricsRow = ToSQLiteRecord<RecommenderMetrics>;
/**
 * Defines an alias for converting a TokenPerformance object into a SQLite record format.
 */
export type TokenPerformanceRow = ToSQLiteRecord<TokenPerformance>;
/**
 * Represents a single row of data in a SQLite database table, corresponding to the Position model.
 */
export type PositionRow = ToSQLiteRecord<Position>;
/**
 * A type alias representing a row in the Transaction table,
 * serialized as a SQLite record.
 */
export type TransactionRow = ToSQLiteRecord<Transaction>;

/**
 * Interface representing the metrics of a recommender.
 * @typedef {{
 *    entityId: UUID,
 *    platform: string,
 *    totalRecommendations: number,
 *    successfulRecs: number,
 *    failedTrades: number,
 *    totalProfit: number,
 *    avgTokenPerformance: number,
 *    consistencyScore: number,
 *    trustScore: number,
 *    lastUpdated: Date,
 *    createdAt: Date
 * }} RecommenderMetrics
 */
export interface RecommenderMetrics {
	entityId: UUID;
	platform: string;
	totalRecommendations: number;
	successfulRecs: number;
	failedTrades: number;
	totalProfit: number;
	avgTokenPerformance: number;
	consistencyScore: number;
	trustScore: number;
	lastUpdated: Date;
	createdAt: Date;
}

/**
 * Interface representing the history of recommender metrics for a specific entity.
 * @typedef {Object} RecommenderMetricsHistory
 * @property {UUID} entityId - The ID of the entity for which the metrics are recorded.
 * @property {RecommenderMetrics} metrics - The metrics related to the entity.
 * @property {Date} timestamp - The timestamp when the metrics were recorded.
 */
export interface RecommenderMetricsHistory {
	entityId: UUID;
	metrics: RecommenderMetrics;
	timestamp: Date;
}

/**
 * Interface representing performance data for a token.
 * @typedef {Object} TokenPerformance
 * @property {string} [chain] - The blockchain network the token belongs to.
 * @property {string} [address] - The address of the token.
 * @property {string} [name] - The name of the token.
 * @property {string} [symbol] - The symbol of the token.
 * @property {number} [decimals] - The number of decimal places for the token.
 * @property {Object.<string, any>} [metadata] - Additional metadata for the token.
 * @property {number} [price] - The current price of the token.
 * @property {number} [price24hChange] - The percentage change in price over the last 24 hours.
 * @property {number} [volume] - The trading volume of the token.
 * @property {number} [volume24hChange] - The percentage change in trading volume over the last 24 hours.
 * @property {number} [trades] - The number of trades for the token.
 * @property {number} [trades24hChange] - The percentage change in number of trades over the last 24 hours.
 * @property {number} [liquidity] - The liquidity of the token.
 * @property {number} [holders] - The number of holders of the token.
 * @property {number} [holders24hChange] - The percentage change in number of holders over the last 24 hours.
 * @property {number} [initialMarketCap] - The initial market capitalization of the token.
 * @property {number} [currentMarketCap] - The current market capitalization of the token.
 * @property {boolean} [rugPull] - Indicates if the token is associated with a rug pull.
 * @property {boolean} [isScam] - Indicates if the token is considered a scam.
 * @property {boolean} [sustainedGrowth] - Indicates if the token has shown sustained growth.
 * @property {boolean} [rapidDump] - Indicates if the token has experienced a rapid dump in price.
 * @property {boolean} [suspiciousVolume] - Indicates if the token has suspicious trading volume.
 * @property {number} [validationTrust] - The level of trust in the token's validation.
 * @property {Date} [createdAt] - The date and time when the token performance data was created.
 * @property {Date} [updatedAt] - The date and time when the token performance data was last updated.
 */
export interface TokenPerformance {
	chain?: string;
	address?: string;
	name?: string;
	symbol?: string;
	decimals?: number;
	metadata?: TokenMetadataRecord;
	price?: number;
	price24hChange?: number;
	volume?: number;
	volume24hChange?: number;
	trades?: number;
	trades24hChange?: number;
	liquidity?: number;
	holders?: number;
	holders24hChange?: number;
	initialMarketCap?: number;
	currentMarketCap?: number;
	rugPull?: boolean;
	isScam?: boolean;
	sustainedGrowth?: boolean;
	rapidDump?: boolean;
	suspiciousVolume?: boolean;
	validationTrust?: number;
	createdAt?: Date;
	updatedAt?: Date;
}

/**
 * Conviction levels for recommendations
 * IMPORTANT: Must match the enum in config.ts
 */
/**
 * Enumeration representing levels of conviction.
 * @readonly
 * @enum {string}
 * @property {string} NONE - No conviction.
 * @property {string} LOW - Low level of conviction.
 * @property {string} MEDIUM - Medium level of conviction.
 * @property {string} HIGH - High level of conviction.
 * @property {string} VERY_HIGH - Very high level of conviction.
 */
export enum Conviction {
	NONE = "NONE",
	LOW = "LOW",
	MEDIUM = "MEDIUM",
	HIGH = "HIGH",
	VERY_HIGH = "VERY_HIGH",
	NEUTRAL = "NEUTRAL",
}

/**
 * Recommendation types
 * IMPORTANT: Must match the enum in config.ts
 */
export enum RecommendationType {
	BUY = "BUY",
	DONT_BUY = "DONT_BUY",
	SELL = "SELL",
	DONT_SELL = "DONT_SELL",
	NONE = "NONE",
	HOLD = "HOLD",
}

export type TokenRecommendation = {
	id: UUID;
	entityId: UUID;
	chain: string;
	tokenAddress: string;
	conviction: Conviction;
	type: RecommendationType;
	initialMarketCap: string;
	initialLiquidity: string;
	initialPrice: string;
	marketCap: string;
	liquidity: string;
	price: string;
	rugPull: boolean;
	isScam: boolean;
	riskScore: number;
	performanceScore: number;
	metadata: TokenMetadataRecord;
	status: "ACTIVE" | "COMPLETED" | "EXPIRED" | "WITHDRAWN";
	createdAt: Date;
	updatedAt: Date;
};

export interface Position {
	id: UUID;
	entityId: UUID;
	tokenAddress: string;
	chain: string;
	walletAddress: string;
	balance: string;
	status: "OPEN" | "CLOSED";
	createdAt: Date;
	closedAt?: Date;
	isSimulation: boolean;
	amount: string;
	initialPrice: string;
	currentPrice?: string;
	recommendationId: UUID;
}

export type PositionWithBalance = Position & {
	balance: bigint;
};

/**
 * Unified transaction type enums to ensure consistency
 * IMPORTANT: Must match the enum in config.ts
 */
export enum TransactionType {
	BUY = "BUY",
	SELL = "SELL",
	TRANSFER_IN = "transfer_in",
	TRANSFER_OUT = "transfer_out",
}

/**
 * Complete transaction interface with all possible fields
 */
export interface Transaction {
	id: UUID;
	positionId: UUID;
	tokenAddress: string;
	type: TransactionType;
	amount: string;
	valueUsd?: number;
	marketCap?: number;
	liquidity?: number;
	price: string;
	isSimulation: boolean;
	timestamp: Date;
	chain?: string;
	transactionHash?: string;
}

export type SellDetails = {
	price: number;
	timestamp: string;
	amount: bigint;
	receivedSol: bigint;
	valueUsd: number;
	profitUsd: number;
	profitPercent: number;
	marketCap: number;
	marketCapChange: number;
	liquidity: number;
	liquidityChange: number;
	rapidDump: boolean;
	entityId: string;
};

export type BuyData = {
	positionId: string;
	chain: string;
	tokenAddress: string;
	walletAddress: string;
	entityID: UUID;
	recommendationId: string;
	solAmount: bigint;
	buyAmount: bigint;
	timestamp: Date;
	initialTokenPriceUsd: string;
	isSimulation: boolean;
	txHash: string;
};

export type SellData = {
	positionId: string;
	chain: string;
	tokenAddress: string;
	walletAddress: string;
	entityID: UUID;
	solAmount: bigint;
	sellAmount: bigint;
	timestamp: Date;
	isSimulation: boolean;
	txHash: string;
};

export type RecommenderAnalytics = {
	entityId: string;
	trustScore: number;
	riskScore: number;
	consistencyScore: number;
	recommenderMetrics: RecommenderMetrics;
};

export type TokenRecommendationSummary = {
	chain: string;
	tokenAddress: string;
	averageTrustScore: number;
	averageRiskScore: number;
	averageConsistencyScore: number;
	recommenders: RecommenderAnalytics[];
};

export type TransactionData = {
	chain: string;
	tokenAddress: string;
	pairId: string;
	amount: string;
	currentBalance: string;
	sellRecommenderId: string;
	walletAddress: string;
	transaction: Transaction | null;
	isSimulation: boolean;
};

export type QuoteResult<Data = unknown> = {
	amountOut: bigint;
	data?: Data;
};

export type SwapInResult<Data = unknown> = {
	txHash: string;
	amountOut: bigint;
	timestamp: Date;
	data?: Data;
};

export type QuoteInParams = {
	inputToken: string;
	outputToken: string;
	amountIn: bigint;
	slippageBps?: number;
};

export type SwapInParams<SwapData = unknown> = {
	inputToken: string;
	outputToken: string;
	amountIn: bigint;
	minAmountOut: bigint;
	isSimulation: boolean;
	data?: SwapData;
};

export interface TrustWalletProvider<
	QuoteData = unknown,
	TQuoteResult extends QuoteResult<QuoteData> = QuoteResult<QuoteData>,
	SwapResultData = unknown,
	TSwapResult extends
		SwapInResult<SwapResultData> = SwapInResult<SwapResultData>,
> {
	getCurrencyAddress(): string;
	getAddress(): string;
	getQuoteIn(props: QuoteInParams): Promise<TQuoteResult>;
	swapIn(props: SwapInParams<QuoteData>): Promise<TSwapResult>;

	executeSwap<SwapData = unknown, SwapResultData = unknown>(params: {
		inputToken: string;
		outputToken: string;
		swapData: SwapData;
	}): Promise<SwapInResult<SwapResultData>>;

	getTokenFromWallet(tokenSymbol: string): Promise<string | null>;
	getAccountBalance(): Promise<bigint>;
}

export type TokenMetadata = {
	chain: string;
	address: string;
	name: string;
	symbol: string;
	decimals: number;
	metadata: TokenMetadataRecord;
};

export type TokenMarketData = {
	price: number;
	priceUsd: string;
	price24hChange: number;

	marketCap: number;

	uniqueWallet24h: number;
	uniqueWallet24hChange: number;

	volume24h: number;
	volume24hChange: number;

	trades: number;
	trades24hChange: number;

	liquidityUsd: number;

	holders: number;
};

// Message recommendation extracted from text
export interface MessageRecommendation {
	tokenMentioned: string;
	isTicker: boolean;
	sentiment: "positive" | "negative" | "neutral";
	conviction: "NONE" | "LOW" | "MEDIUM" | "HIGH";
	quote: string;
}

export interface RecommendationMemory extends Memory {
	content: Content & {
		recommendation: MessageRecommendation & {
			confirmed?: boolean;
		};
	};
}

// TODO: Consolidate this into "Entity" with metadata
export type Account = {
	id: UUID;
	name: string;
	username: string;
	email: string;
	avatarUrl: string;
	telegramId: string;
	discordId: string;
};

export type TokenTradeData = {
	address: string;
	holder: number;
	market: number;
	last_trade_unix_time: number;
	last_trade_human_time: string;
	price: number;
	history_30m_price: number;
	price_change_30m_percent: number;
	history_1h_price: number;
	price_change_1h_percent: number;
	history_2h_price: number;
	price_change_2h_percent: number;
	history_4h_price: number;
	price_change_4h_percent: number;
	history_6h_price: number;
	price_change_6h_percent: number;
	history_8h_price: number;
	price_change_8h_percent: number;
	history_12h_price: number;
	price_change_12h_percent: number;
	history_24h_price: number;
	price_change_24h_percent: number;
	unique_wallet_30m: number;
	unique_wallet_history_30m: number;
	unique_wallet_30m_change_percent: number;
	unique_wallet_1h: number;
	unique_wallet_history_1h: number;
	unique_wallet_1h_change_percent: number;
	unique_wallet_2h: number;
	unique_wallet_history_2h: number;
	unique_wallet_2h_change_percent: number;
	unique_wallet_4h: number;
	unique_wallet_history_4h: number;
	unique_wallet_4h_change_percent: number;
	unique_wallet_8h: number;
	unique_wallet_history_8h: number | null;
	unique_wallet_8h_change_percent: number | null;
	unique_wallet_24h: number;
	unique_wallet_history_24h: number | null;
	unique_wallet_24h_change_percent: number | null;
	trade_30m: number;
	trade_history_30m: number;
	trade_30m_change_percent: number;
	sell_30m: number;
	sell_history_30m: number;
	sell_30m_change_percent: number;
	buy_30m: number;
	buy_history_30m: number;
	buy_30m_change_percent: number;
	volume_30m: number;
	volume_30m_usd: number;
	volume_history_30m: number;
	volume_history_30m_usd: number;
	volume_30m_change_percent: number;
	volume_buy_30m: number;
	volume_buy_30m_usd: number;
	volume_buy_history_30m: number;
	volume_buy_history_30m_usd: number;
	volume_buy_30m_change_percent: number;
	volume_sell_30m: number;
	volume_sell_30m_usd: number;
	volume_sell_history_30m: number;
	volume_sell_history_30m_usd: number;
	volume_sell_30m_change_percent: number;
	trade_1h: number;
	trade_history_1h: number;
	trade_1h_change_percent: number;
	sell_1h: number;
	sell_history_1h: number;
	sell_1h_change_percent: number;
	buy_1h: number;
	buy_history_1h: number;
	buy_1h_change_percent: number;
	volume_1h: number;
	volume_1h_usd: number;
	volume_history_1h: number;
	volume_history_1h_usd: number;
	volume_1h_change_percent: number;
	volume_buy_1h: number;
	volume_buy_1h_usd: number;
	volume_buy_history_1h: number;
	volume_buy_history_1h_usd: number;
	volume_buy_1h_change_percent: number;
	volume_sell_1h: number;
	volume_sell_1h_usd: number;
	volume_sell_history_1h: number;
	volume_sell_history_1h_usd: number;
	volume_sell_1h_change_percent: number;
	trade_2h: number;
	trade_history_2h: number;
	trade_2h_change_percent: number;
	sell_2h: number;
	sell_history_2h: number;
	sell_2h_change_percent: number;
	buy_2h: number;
	buy_history_2h: number;
	buy_2h_change_percent: number;
	volume_2h: number;
	volume_2h_usd: number;
	volume_history_2h: number;
	volume_history_2h_usd: number;
	volume_2h_change_percent: number;
	volume_buy_2h: number;
	volume_buy_2h_usd: number;
	volume_buy_history_2h: number;
	volume_buy_history_2h_usd: number;
	volume_buy_2h_change_percent: number;
	volume_sell_2h: number;
	volume_sell_2h_usd: number;
	volume_sell_history_2h: number;
	volume_sell_history_2h_usd: number;
	volume_sell_2h_change_percent: number;
	trade_4h: number;
	trade_history_4h: number;
	trade_4h_change_percent: number;
	sell_4h: number;
	sell_history_4h: number;
	sell_4h_change_percent: number;
	buy_4h: number;
	buy_history_4h: number;
	buy_4h_change_percent: number;
	volume_4h: number;
	volume_4h_usd: number;
	volume_history_4h: number;
	volume_history_4h_usd: number;
	volume_4h_change_percent: number;
	volume_buy_4h: number;
	volume_buy_4h_usd: number;
	volume_buy_history_4h: number;
	volume_buy_history_4h_usd: number;
	volume_buy_4h_change_percent: number;
	volume_sell_4h: number;
	volume_sell_4h_usd: number;
	volume_sell_history_4h: number;
	volume_sell_history_4h_usd: number;
	volume_sell_4h_change_percent: number;
	trade_8h: number;
	trade_history_8h: number | null;
	trade_8h_change_percent: number | null;
	sell_8h: number;
	sell_history_8h: number | null;
	sell_8h_change_percent: number | null;
	buy_8h: number;
	buy_history_8h: number | null;
	buy_8h_change_percent: number | null;
	volume_8h: number;
	volume_8h_usd: number;
	volume_history_8h: number;
	volume_history_8h_usd: number;
	volume_8h_change_percent: number | null;
	volume_buy_8h: number;
	volume_buy_8h_usd: number;
	volume_buy_history_8h: number;
	volume_buy_history_8h_usd: number;
	volume_buy_8h_change_percent: number | null;
	volume_sell_8h: number;
	volume_sell_8h_usd: number;
	volume_sell_history_8h: number;
	volume_sell_history_8h_usd: number;
	volume_sell_8h_change_percent: number | null;
	trade_24h: number;
	trade_history_24h: number;
	trade_24h_change_percent: number | null;
	sell_24h: number;
	sell_history_24h: number;
	sell_24h_change_percent: number | null;
	buy_24h: number;
	buy_history_24h: number;
	buy_24h_change_percent: number | null;
	volume_24h: number;
	volume_24h_usd: number;
	volume_history_24h: number;
	volume_history_24h_usd: number;
	volume_24h_change_percent: number | null;
	volume_buy_24h: number;
	volume_buy_24h_usd: number;
	volume_buy_history_24h: number;
	volume_buy_history_24h_usd: number;
	volume_buy_24h_change_percent: number | null;
	volume_sell_24h: number;
	volume_sell_24h_usd: number;
	volume_sell_history_24h: number;
	volume_sell_history_24h_usd: number;
	volume_sell_24h_change_percent: number | null;
};

export type HolderData = {
	address: string;
	balance: string;
};

export type TokenSecurityData = {
	ownerBalance: string;
	creatorBalance: string;
	ownerPercentage: number;
	creatorPercentage: number;
	top10HolderBalance: string;
	top10HolderPercent: number;
};

export type ProcessedTokenData = {
	token: TokenOverview;
	security: TokenSecurityData;
	tradeData: TokenTradeData;
	holderDistributionTrend: string; // 'increasing' | 'decreasing' | 'stable'
	highValueHolders: {
		holderAddress: string;
		balanceUsd: string;
	}[];
	recentTrades: boolean;
	highSupplyHoldersCount: number;
	dexScreenerData: DexScreenerData;

	isDexScreenerListed: boolean;
	isDexScreenerPaid: boolean;
};

export type DexScreenerPair = {
	chainId: string;
	dexId: string;
	url: string;
	pairAddress: string;
	baseToken: {
		address: string;
		name: string;
		symbol: string;
	};
	quoteToken: {
		address: string;
		name: string;
		symbol: string;
	};
	priceNative: string;
	priceUsd: string;
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
		usd: number;
		base: number;
		quote: number;
	};
	fdv: number;
	marketCap: number;
	pairCreatedAt: number;
	info: {
		imageUrl: string;
		websites: { label: string; url: string }[];
		socials: { type: string; url: string }[];
	};
	boosts: {
		active: number;
	};
};

export type DexScreenerData = {
	schemaVersion: string;
	pairs: DexScreenerPair[];
};

export type Prices = {
	solana: { usd: string };
	bitcoin: { usd: string };
	ethereum: { usd: string };
};

export type CalculatedBuyAmounts = {
	none: 0;
	low: number;
	medium: number;
	high: number;
};

export type WalletPortfolioItem = {
	name: string;
	address: string;
	symbol: string;
	decimals: number;
	balance: string;
	uiAmount: string;
	priceUsd: string;
	valueUsd: string;
	valueSol?: string;
};

export type WalletPortfolio = {
	totalUsd: string;
	totalSol?: string;
	items: WalletPortfolioItem[];
};

export type TokenOverview = {
	address: string;
	name: string;
	symbol: string;
	decimals?: number;
	logoURI?: string;
};

export interface BuySignalMessage {
	positionId?: string;
	tokenAddress: string;
	chain: string;
	walletAddress: string;
	isSimulation: boolean;
	entityId: string;
	recommendationId: string;
	price: string;
	marketCap: string;
	liquidity: string;
	amount: string;
	type: RecommendationType;
	conviction: Conviction;
}

export interface Trade {
	id: string;
	positionId: string;
	type: TransactionType.BUY | TransactionType.SELL;
	amount: bigint;
	price: bigint;
	timestamp: Date;
	txHash: string;
}

export interface TradePerformance {
	token_address: string;
	recommender_id: string;
	buy_price: number;
	sell_price: number;
	buy_timeStamp: string;
	sell_timeStamp: string;
	buy_amount: number;
	sell_amount: number;
	buy_sol: number;
	received_sol: number;
	buy_value_usd: number;
	sell_value_usd: number;
	profit_usd: number;
	profit_percent: number;
	buy_market_cap: number;
	sell_market_cap: number;
	market_cap_change: number;
	buy_liquidity: number;
	sell_liquidity: number;
	liquidity_change: number;
	last_updated: string;
	rapidDump: boolean;
}

/**
 * Represents the metrics of a trade including total bought quantity, total bought value, total sold quantity,
 * total sold value, total transfer in quantity, total transfer out quantity, average entry price, average exit price,
 * realized profit and loss, realized profit and loss percentage, volume in USD, first trade time, and last trade time.
 * @typedef {Object} TradeMetrics
 * @property {number} totalBought - The total quantity bought
 * @property {number} totalBoughtValue - The total value of items bought
 * @property {number} totalSold - The total quantity sold
 * @property {number} totalSoldValue - The total value of items sold
 * @property {number} totalTransferIn - The total quantity transferred in
 * @property {number} totalTransferOut - The total quantity transferred out
 * @property {number} averageEntryPrice - The average price at which items were bought
 * @property {number} averageExitPrice - The average price at which items were sold
 * @property {number} realizedPnL - The realized profit and loss
 * @property {number} realizedPnLPercent - The realized profit and loss percentage
 * @property {number} volumeUsd - The volume in USD
 * @property {Date} firstTradeTime - The timestamp of the first trade
 * @property {Date} lastTradeTime - The timestamp of the last trade
 */
export type TradeMetrics = {
	totalBought: number;
	totalBoughtValue: number;
	totalSold: number;
	totalSoldValue: number;
	totalTransferIn: number;
	totalTransferOut: number;
	averageEntryPrice: number;
	averageExitPrice: number;
	realizedPnL: number;
	realizedPnLPercent: number;
	volumeUsd: number;
	firstTradeTime: Date;
	lastTradeTime: Date;
};

/**
 * Type for position performance statistics.
 * Includes information about the position such as token, current value, initial value, profit/loss, profit/loss percentage,
 * price change, price change percentage, normalized balance, trade metrics, unrealized profit/loss, unrealized profit/loss percentage,
 * total profit/loss, and total profit/loss percentage.
 */
export type PositionPerformance = Pretty<
	PositionWithBalance & {
		token: TokenPerformance;
		currentValue: number;
		initialValue: number;
		profitLoss: number;
		profitLossPercentage: number;
		priceChange: number;
		priceChangePercentage: number;
		normalizedBalance: number;
		trades: TradeMetrics;
		unrealizedPnL: number;
		unrealizedPnLPercent: number;
		totalPnL: number;
		totalPnLPercent: number;
	}
>;

// ServiceType Enum to identify the service within the runtime
export enum ServiceType {
	COMMUNITY_INVESTOR = "community-investor",
}

// Supported cryptocurrency chains
export enum SupportedChain {
	SOLANA = "SOLANA",
	ETHEREUM = "ETHEREUM",
	BASE = "BASE",
	UNKNOWN = "UNKNOWN", // For cases where chain can't be determined
}

// Metrics calculated after observing a recommendation's market performance
export interface RecommendationMetric {
	potentialProfitPercent?: number; // e.g., based on ATH after recommendation or price after X days for BUYs
	avoidedLossPercent?: number; // For SELL/criticism, based on price drop avoided
	isScamOrRug?: boolean; // Flagged based on heuristics
	evaluationTimestamp: number; // When this metric was last calculated
	notes?: string; // e.g., "Hit ATH 3 days later", "Rug pulled", "Low liquidity spike"
	[key: string]: MetadataValue | undefined;
}

// Represents a single recommendation or criticism made by a user
export interface Recommendation {
	id: UUID; // Unique ID for this recommendation instance
	userId: UUID; // Entity ID of the recommender
	messageId: UUID; // Original message ID that sparked this recommendation
	timestamp: number; // When the recommendation was made (from original message)
	tokenTicker?: string; // e.g., "SOL", "BTC" (if identified as a ticker)
	tokenAddress: string; // e.g., "So11111111111111111111111111111111111111112"
	chain: SupportedChain; // The blockchain the token is on
	recommendationType: "BUY" | "SELL"; // 'SELL' for criticisms
	conviction: Conviction; // Sender's conviction level - CHANGED TO USE ENUM
	rawMessageQuote: string; // The exact text snippet that is the recommendation/criticism
	priceAtRecommendation?: number; // Price of the token when the recommendation was made
	metrics?: RecommendationMetric; // Performance metrics, calculated later by a task
	processedForTradeDecision?: boolean; // Has the PROCESS_TRADE_DECISION task run for this?
	[key: string]: MetadataValue | undefined;
}

// Data structure for the component stored on an Entity
export interface UserTrustProfile {
	version: string; // Schema version, e.g., "1.0.0"
	userId: UUID; // Entity ID this profile belongs to
	trustScore: number; // Weighted average score from -100 to 100
	lastTrustScoreCalculationTimestamp: number; // When trustScore was last calculated
	lastTradeDecisionMadeTimestamp?: number; // For the 12-hour cooldown for *acting* on this user's recs
	recommendations: Recommendation[]; // Array of recommendations made by this user
	// Allow additional properties for Metadata compatibility
	[key: string]: MetadataValue | undefined;
}

// Type alias for the data field within the ElizaOS Component
export type TrustMarketplaceComponentData = UserTrustProfile;

// Constant for the component type name used in runtime.getComponent/createComponent
export const TRUST_MARKETPLACE_COMPONENT_TYPE = "communityInvestorProfile";

// Payload for the PROCESS_TRADE_DECISION task
export interface TradeDecisionInput {
	recommendationId: UUID;
	userId: UUID;
}

// Structure for data fetched from external token APIs (e.g., Birdeye, DexScreener)
export interface TokenAPIData {
	name?: string;
	symbol?: string;
	currentPrice?: number;
	ath?: number;
	atl?: number;
	priceHistory?: { timestamp: number; price: number }[];
	liquidity?: number;
	marketCap?: number;
	isKnownScam?: boolean;
}

export interface HighValueHolder {
	holderAddress: string;
	balanceUsd: string;
}

// Data structure for frontend leaderboard entries
export interface LeaderboardEntry {
	rank?: number;
	userId: UUID;
	username?: string; // Display name for the user
	trustScore: number;
	recommendations: Recommendation[]; // Full recommendation history for drill-down
}

// Interface defining the methods our CommunityInvestorService will provide
// This helps ensure the class implements all necessary functions.
export interface ICommunityInvestorService {
	initialize(runtime: IAgentRuntime): Promise<void>;
	resolveTicker(
		ticker: string,
		chain: SupportedChain,
		contextMessages: Memory[],
	): Promise<{
		address: string;
		chain: SupportedChain;
		ticker?: string;
	} | null>;
	getTokenAPIData(
		address: string,
		chain: SupportedChain,
	): Promise<TokenAPIData | null>;
	isLikelyScamOrRug(
		tokenData: TokenAPIData,
		recommendationTimestamp: number,
	): Promise<boolean>;
	evaluateRecommendationPerformance(
		recommendation: Recommendation,
		tokenData: TokenAPIData,
	): Promise<RecommendationMetric>;
	calculateUserTrustScore(
		userId: UUID,
		runtime: IAgentRuntime,
	): Promise<number>;
	getRecencyWeight(recommendationTimestamp: number): number;
	getConvictionWeight(conviction: Recommendation["conviction"]): number;
	getLeaderboardData(runtime: IAgentRuntime): Promise<LeaderboardEntry[]>;
	// ensureTaskWorkersRegistered(runtime: IAgentRuntime): void; // Task registration is internal to constructor
}

// Adding MessageReceivedHandlerParams
export interface MessageReceivedHandlerParams {
	runtime: IAgentRuntime;
	message: Memory;
	callback: (
		response: string | Record<string, any>,
		metadata?: Record<string, any>,
	) => Promise<void>;
	onComplete?: () => void;
}
