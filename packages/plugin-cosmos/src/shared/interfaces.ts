import type { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import type { Coin, DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import type { assets, chains } from "chain-registry";
import type { SkipClient, StatusState} from "@skip-go/client";

export interface ICosmosPluginCustomChainData {
    chainData: (typeof chains)[number];
    assets: (typeof assets)[number];
}

export interface ICosmosPluginOptions {
    customChainData?: ICosmosPluginCustomChainData[];
}

export interface ICosmosActionService {
    execute: ((...params: unknown[]) => void) | (() => void);
}

export interface ICosmosTransaction {
    from: string;
    to: string;
    txHash: string;
    gasPaid?: number;
}

export interface ICosmosSwap {
    status: StatusState;
    fromChainName: string;
    fromTokenSymbol: string;
    fromTokenAmount: string;
    toTokenSymbol: string;
    toChainName: string;
    txHash: string;
}

export interface ICosmosWallet {
    directSecp256k1HdWallet: DirectSecp256k1HdWallet;

    getWalletAddress(): Promise<string>;
    getWalletBalances(): Promise<Coin[]>;
}

export interface ICosmosChainWallet {
    wallet: ICosmosWallet;
    signingCosmWasmClient: SigningCosmWasmClient;
    skipClient: SkipClient;
}

export interface ICosmosWalletChains {
    walletChainsData: ICosmosWalletChainsData;

    getWalletAddress(chainName: string): Promise<string>;
    getSigningCosmWasmClient(chainName: string): SigningCosmWasmClient;
    getSkipClient(chainName: string): SkipClient;
}

export interface ICosmosWalletChainsData {
    [chainName: string]: ICosmosChainWallet;
}

export type IDenomProvider = (
        sourceAssetDenom: string,
        sourceAssetChainId: string,
        destChainId: string) => Promise<{ denom: string }>
