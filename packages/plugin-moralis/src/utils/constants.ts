export const SOLANA_API_BASE_URL = "https://solana-gateway.moralis.io";

export const API_ENDPOINTS = {
    SOLANA: {
        TOKEN_PAIRS: (tokenAddress: string) =>
            `/token/mainnet/${tokenAddress}/pairs`,
        PAIR_STATS: (pairAddress: string) =>
            `/token/mainnet/pairs/${pairAddress}/stats`,
        PAIR_OHLCV: (pairAddress: string) =>
            `/token/mainnet/pairs/${pairAddress}/ohlcv`,
        TOKEN_STATS: (tokenAddress: string) =>
            `/token/mainnet/${tokenAddress}/pairs/stats`,
        TOKEN_PRICE: (tokenAddress: string) =>
            `/token/mainnet/${tokenAddress}/price`,
        TOKEN_METADATA: (tokenAddress: string) =>
            `/token/mainnet/${tokenAddress}/metadata`,
    },
} as const;
