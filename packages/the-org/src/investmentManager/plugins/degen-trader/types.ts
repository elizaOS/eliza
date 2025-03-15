// Token Security Types
/**
 * Interface representing the security data for a token.
 * @typedef {object} TokenSecurityData
 * @property {string} ownerBalance - The balance of the token owner.
 * @property {string} creatorBalance - The balance of the token creator.
 * @property {number} ownerPercentage - The percentage of the token owned by the owner.
 * @property {number} creatorPercentage - The percentage of the token owned by the creator.
 * @property {string} top10HolderBalance - The balance of the top 10 token holders combined.
 * @property {number} top10HolderPercent - The percentage of tokens held by the top 10 token holders.
 */
export interface TokenSecurityData {
	ownerBalance: string;
	creatorBalance: string;
	ownerPercentage: number;
	creatorPercentage: number;
	top10HolderBalance: string;
	top10HolderPercent: number;
}

// Token Trading Types
/**
 * Interface representing trade data for a token.
 * @typedef {Object} TokenTradeData
 * @property {number} price - The current price of the token.
 * @property {number} priceChange24h - The percentage change in price over the past 24 hours.
 * @property {number} volume24h - The trading volume of the token over the past 24 hours.
 * @property {string} volume24hUsd - The trading volume of the token in USD over the past 24 hours.
 * @property {number} uniqueWallets24h - The number of unique wallets involved in trading the token over the past 24 hours.
 * @property {number} uniqueWallets24hChange - The percentage change in the number of unique wallets over the past 24 hours.
 */
export interface TokenTradeData {
	price: number;
	priceChange24h: number;
	volume24h: number;
	volume24hUsd: string;
	uniqueWallets24h: number;
	uniqueWallets24hChange: number;
}

/**
 * Interface for representing a pair in the DexScreener, which includes information such as price in USD,
 * 24h volume, market capitalization, liquidity in USD and base currency, price change in the last 24 hours,
 * and the number of buys and sells transactions in the last 24 hours.
 */
export interface DexScreenerPair {
	priceUsd: number;
	volume: { h24: number };
	marketCap: number;
	liquidity: { usd: number; base: number };
	priceChange: { h24: number };
	txns: { h24: { buys: number; sells: number } };
}

/**
 * Represents the processed token data object.
 * @typedef {Object} ProcessedTokenData
 * @property {TokenSecurityData} security - The security data of the token.
 * @property {TokenTradeData} tradeData - The trade data of the token.
 * @property {Object} dexScreenerData - The data from Dex Screener with pairs information.
 * @property {DexScreenerPair[]} dexScreenerData.pairs - Array of Dex Screener pairs.
 * @property {string} holderDistributionTrend - The trend of holder distribution.
 * @property {any[]} highValueHolders - Array of high value holders data.
 * @property {boolean} recentTrades - Indicates if there are recent trades.
 * @property {number} highSupplyHoldersCount - The count of high supply holders.
 */

export interface ProcessedTokenData {
	security: TokenSecurityData;
	tradeData: TokenTradeData;
	dexScreenerData: { pairs: DexScreenerPair[] };
	holderDistributionTrend: string;
	highValueHolders: any[];
	recentTrades: boolean;
	highSupplyHoldersCount: number;
}

// Market and Position Types
/**
 * Data structure representing market data.
 * @typedef {Object} MarketData
 * @property {number} priceChange24h - The price change in the last 24 hours.
 * @property {number} volume24h - The trading volume in the last 24 hours.
 * @property {Object} liquidity - Object containing liquidity information.
 * @property {number} liquidity.usd - The amount of liquidity in USD.
 */
export type MarketData = {
	priceChange24h: number;
	volume24h: number;
	liquidity: {
		usd: number;
	};
};

/**
 * Represents a position in the trading system.
 * @typedef {Object} Position
 * @property {string} token - The token symbol.
 * @property {string} tokenAddress - The address of the token.
 * @property {number} entryPrice - The price at which the position was entered.
 * @property {number} amount - The amount of the token in the position.
 * @property {number} timestamp - The timestamp of when the position was opened.
 * @property {boolean} [sold] - Indicates if the position has been sold.
 * @property {number} [exitPrice] - The price at which the position was exited.
 * @property {number} [exitTimestamp] - The timestamp of when the position was closed.
 * @property {Object} initialMetrics - The initial metrics of the token.
 * @property {number} initialMetrics.trustScore - The trust score of the token.
 * @property {number} initialMetrics.volume24h - The 24-hour trading volume of the token.
 * @property {Object} initialMetrics.liquidity - The liquidity of the token.
 * @property {number} initialMetrics.liquidity.usd - The liquidity in USD.
 * @property {"LOW" | "MEDIUM" | "HIGH"} initialMetrics.riskLevel - The risk level associated with the token.
 * @property {number} [highestPrice] - The highest price reached by the token since opening the position.
 * @property {boolean} [partialTakeProfit] - Indicates if a partial take profit has been made from the position.
 */

export type Position = {
	token: string;
	tokenAddress: string;
	entryPrice: number;
	amount: number;
	timestamp: number;
	sold?: boolean;
	exitPrice?: number;
	exitTimestamp?: number;
	initialMetrics: {
		trustScore: number;
		volume24h: number;
		liquidity: { usd: number };
		riskLevel: "LOW" | "MEDIUM" | "HIGH";
	};
	highestPrice?: number;
	partialTakeProfit?: boolean;
};

// Analysis Types
/**
 * Represents the analysis of a token including security, trading, and market information.
 * @typedef {Object} TokenAnalysis
 * @property {Object} security - Security-related information
 * @property {string} security.ownerBalance - The balance of the token owner
 * @property {string} security.creatorBalance - The balance of the token creator
 * @property {number} security.ownerPercentage - The percentage of token owned by the owner
 * @property {number} security.top10HolderPercent - The percentage owned by the top 10 holders
 * @property {Object} trading - Trading-related information
 * @property {number} trading.price - The current price of the token
 * @property {number} trading.priceChange24h - The price change in the last 24 hours
 * @property {number} trading.volume24h - The trading volume in the last 24 hours
 * @property {number} trading.uniqueWallets24h - The number of unique wallets that traded in the last 24 hours
 * @property {Object} trading.walletChanges - Changes in unique wallets information
 * @property {number} trading.walletChanges.unique_wallet_30m_change_percent - The percentage change in unique wallets in the last 30 minutes
 * @property {number} trading.walletChanges.unique_wallet_1h_change_percent - The percentage change in unique wallets in the last 1 hour
 * @property {number} trading.walletChanges.unique_wallet_24h_change_percent - The percentage change in unique wallets in the last 24 hours
 * @property {Object} market - Market-related information
 * @property {number} market.liquidity - The liquidity of the token
 * @property {number} market.marketCap - The market capitalization of the token
 * @property {number} market.fdv - The fully diluted valuation of the token
 */
export type TokenAnalysis = {
	security: {
		ownerBalance: string;
		creatorBalance: string;
		ownerPercentage: number;
		top10HolderPercent: number;
	};
	trading: {
		price: number;
		priceChange24h: number;
		volume24h: number;
		uniqueWallets24h: number;
		walletChanges: {
			unique_wallet_30m_change_percent: number;
			unique_wallet_1h_change_percent: number;
			unique_wallet_24h_change_percent: number;
		};
	};
	market: {
		liquidity: number;
		marketCap: number;
		fdv: number;
	};
};

/**
 * Interface representing the state of token analysis.
 * @typedef {Object} TokenAnalysisState
 * @property {number} lastAnalyzedIndex - The index of the last token analyzed.
 * @property {Set<string>} analyzedTokens - A set of already analyzed tokens.
 */
export interface TokenAnalysisState {
	lastAnalyzedIndex: number;
	analyzedTokens: Set<string>;
}

// Signal Types
/**
 * Interface for a buy signal message.
 * @interface
 * @property {string} positionId - The ID of the position.
 * @property {string} tokenAddress - The address of the token.
 * @property {string} entityId - The ID of the entity.
 */
export interface BuySignalMessage {
	positionId: string;
	tokenAddress: string;
	entityId: string;
}

/**
 * Interface representing a sell signal message.
 * @interface SellSignalMessage
 * @property {string} positionId - The unique identifier for the position.
 * @property {string} tokenAddress - The address of the token being sold.
 * @property {string} [pairId] - The optional unique identifier for the pair.
 * @property {string} amount - The amount of the token being sold.
 * @property {string} [currentBalance] - The current balance of the token.
 * @property {string} [sellRecommenderId] - The unique identifier for the sell recommender.
 * @property {string} [walletAddress] - The address of the wallet associated with the sell action.
 * @property {boolean} [isSimulation] - Indicates if the sell action is a simulation.
 * @property {string} [reason] - The reason for the sell signal.
 * @property {string} [entityId] - The unique identifier for the entity related to the sell signal.
 * @property {"low" | "medium" | "high"} confidence - The confidence level of the sell signal.
 */

export interface SellSignalMessage {
	positionId: string;
	tokenAddress: string;
	pairId?: string;
	amount: string;
	currentBalance?: string;
	sellRecommenderId?: string;
	walletAddress?: string;
	isSimulation?: boolean;
	reason?: string;
	entityId?: string;
	confidence?: "low" | "medium" | "high";
}

/**
 * Interface representing parameters needed to execute a quote.
 * @property {string} inputMint - The input token mint.
 * @property {string} outputMint - The output token mint.
 * @property {string} amount - The amount of tokens to be exchanged.
 * @property {string} walletAddress - The wallet address of the user.
 * @property {number} slippageBps - The slippage tolerance in basis points.
 */
export interface QuoteParams {
	inputMint: string;
	outputMint: string;
	amount: string;
	walletAddress: string;
	slippageBps: number;
}

/**
 * Interface representing parameters required to start a process.
 * @property {string} id - The unique identifier of the process.
 * @property {string} tokenAddress - The address of the token associated with the process.
 * * @property {string} balance - The initial balance of the process.
 * @property {boolean} isSimulation - Flag indicating if the process is a simulation.
 * @property {string} initialMarketCap - The initial market capitalization of the process.
 * @property {string} entityId - The unique identifier of the entity involved in the process.
 * @property {string} [walletAddress] - The address of the wallet associated with the process (optional).
 * @property {string} [txHash] - The transaction hash associated with the process (optional).
 */
export interface StartProcessParams {
	id: string;
	tokenAddress: string;
	balance: string;
	isSimulation: boolean;
	initialMarketCap: string;
	entityId: string;
	walletAddress?: string;
	txHash?: string;
}

/**
 * Interface representing parameters needed to add a transaction.
 * @typedef {object} AddTransactionParams
 * @property {string} id - The unique identifier for the transaction.
 * @property {string} address - The address associated with the transaction.
 * @property {string} amount - The amount of the transaction.
 * @property {string} walletAddress - The wallet address related to the transaction.
 * @property {boolean} isSimulation - Flag indicating if the transaction is a simulation.
 * @property {number} marketCap - The market capitalization related to the transaction.
 * @property {string} entityId - The entity identifier related to the transaction.
 * @property {string} txHash - The transaction hash associated with the transaction.
 */
export interface AddTransactionParams {
	id: string;
	address: string;
	amount: string;
	walletAddress: string;
	isSimulation: boolean;
	marketCap: number;
	entityId: string;
	txHash: string;
}

/**
 * Interface representing a Price Signal Message.
 * @typedef {Object} PriceSignalMessage
 * @property {string} initialPrice - The initial price of the token.
 * @property {string} currentPrice - The current price of the token.
 * @property {number} priceChange - The change in price of the token.
 * @property {string} tokenAddress - The address of the token.
 */
export interface PriceSignalMessage {
	initialPrice: string;
	currentPrice: string;
	priceChange: number;
	tokenAddress: string;
}

/**
 * Interface representing the parameters for starting a degen process.
 * Extends StartProcessParams interface.
 * @property {string} initialPrice - The initial price for the process.
 */
export interface StartDegenProcessParams extends StartProcessParams {
	initialPrice: string;
}

export const ServiceType = {
	DEGEN_TRADING: "degen_trader",
} as const;
