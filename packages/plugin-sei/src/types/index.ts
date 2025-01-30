import type { Token } from "@lifi/types";
import type {
    Account,
    Address,
    Chain,
    Hash,
    HttpTransport,
    PublicClient,
    WalletClient,
} from "viem";
import * as viemChains from "viem/chains";
export * from "./precompiles"

const _SupportedChainList = Object.keys([viemChains.seiDevnet, viemChains.seiTestnet, viemChains.sei]) as Array<
    keyof typeof viemChains
>;

export interface ChainWithName {
    name: string;
    chain: Chain
}

// Transaction types
export interface Transaction {
    hash: Hash;
    from: Address;
    to: string;
    value: bigint;
    data?: `0x${string}`;
    chainId?: number;
}

// Token types
export interface TokenWithBalance {
    token: Token;
    balance: bigint;
    formattedBalance: string;
    priceUSD: string;
    valueUSD: string;
}

export interface WalletBalance {
    chain: string;
    address: Address;
    totalValueUSD: string;
    tokens: TokenWithBalance[];
}

export interface ChainConfig {
    chain: Chain;
    publicClient: PublicClient<HttpTransport, Chain, Account | undefined>;
    walletClient?: WalletClient;
}

// Action parameters
export interface TransferParams {
    toAddress: string;
    amount: string;
    data?: `0x${string}`;
}

// Provider types
export interface TokenData extends Token {
    symbol: string;
    decimals: number;
    address: Address;
    name: string;
    logoURI?: string;
    chainId: number;
}

export interface ProviderError extends Error {
    code?: number;
    data?: unknown;
}