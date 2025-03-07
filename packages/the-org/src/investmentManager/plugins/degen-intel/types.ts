export type TChain = "solana" | "base" | "ethereum" | "L1";
export type TDataProvider = "birdeye" | "coinmarketcap";

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

export interface ISentimentToken {
	token: string;
	sentiment: number;
	reason: string;
}

export interface ISentiment {
	timeslot: Date;
	processed?: boolean;
	text: string;
	occuringTokens: ISentimentToken[];
}

export interface IData {
	data: object;
	key: string;
}

export interface ITransactionHistory {
	txHash: string;
	blockTime: Date;
	data: object;
}

export type Job = {
	id: string;
	name: string;
	data: any;
};
