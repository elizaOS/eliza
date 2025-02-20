import type { IAgentRuntime } from "@elizaos/core";
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

export interface ISolanaClient {
    start: () => void;
    stop: (runtime: IAgentRuntime) => Promise<void>;
    getCachedData: () => Promise<WalletPortfolio | null>;
    forceUpdate: () => Promise<WalletPortfolio>;
}