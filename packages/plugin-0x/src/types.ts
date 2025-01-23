export enum Chains {
    arbitrum = 42161,
    avalanche = 43114,
    base = 8453,
    bsc = 56,
    blast = 81457,
    ethereum = 1,
    linea = 59144,
    optimism = 10,
    polygon = 137,
    scroll = 534352,
}

export interface SwapRequestParams {
    chainId: string; // e.g., "1" for Ethereum mainnet
    sellToken: string; // token address to sell
    buyToken: string; // token address to buy
    sellAmount: string; // amount in wei
    taker: string; // wallet address
    slippagePercentage?: string; // optional, e.g., "0.01"
}

export interface GetIndicativePriceResponse {
    chainId: number;
    price: string;
    buyAmount: string;
    buyToken: string;
    sellAmount: string;
    sellToken: string;
    blockNumber: string;
    estimatedPriceImpact: string;
    estimatedGas: string;
    totalNetworkFee: string;
    route: {
        tokens: Array<{
            address: string;
            symbol: string;
            name: string;
            decimals: number;
        }>;
        fills: Array<{
            source: string;
            proportionBps: string;
            from: string;
            to: string;
        }>;
    };
    fees: {
        zeroExFee: {
            amount: string;
            token: string;
            type: "volume";
        } | null;
        integratorFee: {
            amount: string;
            token: string;
            type: "volume";
        } | null;
        gasFee: {
            amount: string;
            token: string;
            type: "volume";
        } | null;
    };
    issues?: {
        balance?: {
            token: string;
            actual: string;
            expected: string;
        };
        allowance?: {
            token: string;
            actual: string;
            expected: string;
        };
    };
    permit2: {
        type: "Permit2";
        hash: string;
        eip712: {
            types: {
                PermitTransferFrom: Array<{ name: string; type: string }>;
                TokenPermissions: Array<{ name: string; type: string }>;
                EIP712Domain: Array<{ name: string; type: string }>;
            };
            domain: {
                name: string;
                chainId: number;
                verifyingContract: string;
            };
            message: {
                permitted: {
                    token: string;
                    amount: string;
                };
                spender: string;
                nonce: string;
                deadline: string;
            };
            primaryType: string;
        };
    };
}

export interface GetQuoteResponse {
    blockNumber: string;
    buyAmount: string;
    buyToken: string;
    sellAmount: string;
    sellToken: string;
    minBuyAmount: string;
    liquidityAvailable: boolean;
    totalNetworkFee: string;
    zid: string;
    fees: {
        zeroExFee: {
            amount: string;
            token: string;
            type: string;
        } | null;
        integratorFee: {
            amount: string;
            token: string;
            type: string;
        } | null;
        gasFee: {
            amount: string;
            token: string;
            type: string;
        } | null;
    };
    issues: {
        allowance: null;
        balance: {
            token: string;
            actual: string;
            expected: string;
        } | null;
        simulationIncomplete: boolean;
        invalidSourcesPassed: string[];
    };
    permit2: {
        type: "Permit2";
        hash: string;
        eip712: {
            types: Record<string, any>;
            domain: Record<string, any>;
            message: Record<string, any>;
            primaryType: string;
        };
    };
    route: {
        fills: Array<{
            from: string;
            to: string;
            source: string;
            proportionBps: string;
        }>;
        tokens: Array<{
            address: string;
            symbol: string;
        }>;
    };
    tokenMetadata: {
        buyToken: {
            buyTaxBps: string;
            sellTaxBps: string;
        };
        sellToken: {
            buyTaxBps: string;
            sellTaxBps: string;
        };
    };
    transaction: {
        to: string;
        data: string;
        gas: string;
        gasPrice: string;
        value: string;
    };
}

export interface TokenMetadata {
    chainId: number;
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    logoURI?: string;
    type: string;
}

export interface TrustWalletTokenMetadata {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    logoURI?: string;
    type: string;
    pairs: string[];
}

export interface TrustWalletGithubJson {
    name: string;
    logoURI: string;
    timestamp: string;
    tokens: TrustWalletTokenMetadata[];
}

export interface PriceInquiry {
    sellTokenObject: TokenMetadata;
    buyTokenObject: TokenMetadata;
    sellAmountBaseUnits: string;
    chainId: number;
    timestamp: string;
}

export interface Quote {
    sellTokenObject: TokenMetadata;
    buyTokenObject: TokenMetadata;
    sellAmountBaseUnits: string;
    chainId: number;
    quote: GetQuoteResponse;
    timestamp: string;
}
