import type { PublicKey } from "@solana/web3.js";

export interface Item {
	name: string;
	address: string;
	symbol: string;
	decimals: number;
	balance: string;
	uiAmount: string;
	priceUsd: string;
	valueUsd: string;
	valueSol?: string;
}

export interface Prices {
	solana: { usd: string };
	bitcoin: { usd: string };
	ethereum: { usd: string };
}

export interface WalletPortfolio {
	totalUsd: string;
	totalSol?: string;
	items: Array<Item>;
	prices?: Prices;
	lastUpdated?: number;
}

export interface TokenAccountInfo {
	pubkey: PublicKey;
	account: {
		lamports: number;
		data: {
			parsed: {
				info: {
					mint: string;
					owner: string;
					tokenAmount: {
						amount: string;
						decimals: number;
						uiAmount: number;
					};
				};
				type: string;
			};
			program: string;
			space: number;
		};
		owner: string;
		executable: boolean;
		rentEpoch: number;
	};
}
