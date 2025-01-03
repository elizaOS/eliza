import { z } from "zod";
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

export type SupportedChain = "odyssey";

// Transaction types
export interface Transaction {
    hash: Hash;
    from: Address;
    to: Address;
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
    chain: SupportedChain;
    address: Address;
    totalValueUSD: string;
    tokens: TokenWithBalance[];
}

// Chain configuration
export interface ChainMetadata {
    chainId: number;
    name: string;
    chain: Chain;
    rpcUrl: string;
    nativeCurrency: {
        name: string;
        symbol: string;
        decimals: number;
    };
    blockExplorerUrl: string;
}

export interface ChainConfig {
    chain: Chain;
    publicClient: PublicClient<HttpTransport, Chain, Account | undefined>;
    walletClient?: WalletClient;
}

// Action parameters
export interface RegisterIPParams {
    title: string;
    description: string;
    ipType: string;
}

export const RegisterIPParamsSchema = z.object({
    title: z.string(),
    description: z.string(),
    ipType: z.string(),
});

export const isRegisterIPParams = (object: any): object is RegisterIPParams => {
    return RegisterIPParamsSchema.safeParse(object).success;
};

export interface LicenseIPParams {
    licensorIpId: Address;
    licenseTermsId: string;
    amount: number;
}

export const LicenseIPParamsSchema = z.object({
    licensorIpId: z.string(),
    licenseTermsId: z.string(),
    amount: z.number(),
});

export const isLicenseIPParams = (object: any): object is LicenseIPParams => {
    return LicenseIPParamsSchema.safeParse(object).success;
};

export interface AttachTermsParams {
    ipId: Address;
    mintingFee: number;
    commercialUse: boolean;
    commercialRevShare: number;
}

export const AttachTermsParamsSchema = z.object({
    ipId: z.string(),
    mintingFee: z.number(),
    commercialUse: z.boolean(),
    commercialRevShare: z.number(),
});

export const isAttachTermsParams = (
    object: any
): object is AttachTermsParams => {
    return AttachTermsParamsSchema.safeParse(object).success;
};

// Plugin configuration
export interface EvmPluginConfig {
    rpcUrl?: {
        ethereum?: string;
        base?: string;
    };
    secrets?: {
        EVM_PRIVATE_KEY: string;
    };
    testMode?: boolean;
    multicall?: {
        batchSize?: number;
        wait?: number;
    };
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

export interface TokenPriceResponse {
    priceUSD: string;
    token: TokenData;
}

export interface TokenListResponse {
    tokens: TokenData[];
}

export interface ProviderError extends Error {
    code?: number;
    data?: unknown;
}
