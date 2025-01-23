import { Chains, TokenMetadata } from "./types";

export const ZX_MEMORY = {
    price: {
        tableName: "0x_prices",
        type: "price_inquiry",
    },
    quote: {
        tableName: "0x_quotes",
        type: "quote",
    },
};

export const CHAIN_NAMES: Record<number, string> = {
    [Chains.ethereum]: "Ethereum",
    [Chains.optimism]: "Optimism",
    [Chains.bsc]: "BSC",
    [Chains.polygon]: "Polygon",
    [Chains.base]: "Base",
    [Chains.arbitrum]: "Arbitrum",
    [Chains.avalanche]: "Avalanche",
    [Chains.linea]: "Linea",
    [Chains.scroll]: "Scroll",
    [Chains.blast]: "Blast",
} as const;

export const CHAIN_EXPLORERS: Record<number, string> = {
    [Chains.ethereum]: "https://etherscan.io",
    [Chains.optimism]: "https://optimistic.etherscan.io",
    [Chains.bsc]: "https://bscscan.com",
    [Chains.polygon]: "https://polygonscan.com",
    [Chains.base]: "https://basescan.org",
    [Chains.arbitrum]: "https://arbiscan.io",
    [Chains.avalanche]: "https://snowtrace.io",
    [Chains.linea]: "https://lineascan.build",
    [Chains.scroll]: "https://scrollscan.com",
    [Chains.blast]: "https://blastscan.io",
} as const;

export const NATIVE_TOKEN_ADDRESS =
    "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const NATIVE_TOKENS: Record<number, TokenMetadata> = {
    [Chains.ethereum]: {
        chainId: Chains.ethereum,
        name: "Ethereum",
        symbol: "ETH",
        decimals: 18,
        address: NATIVE_TOKEN_ADDRESS,
        type: "NATIVE",
        logoURI:
            "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
    },
    [Chains.optimism]: {
        chainId: Chains.optimism,
        name: "Ethereum",
        symbol: "ETH",
        decimals: 18,
        address: NATIVE_TOKEN_ADDRESS,
        type: "NATIVE",
        logoURI:
            "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/optimism/info/logo.png",
    },
    [Chains.bsc]: {
        chainId: Chains.bsc,
        name: "BNB Chain",
        symbol: "BNB",
        decimals: 18,
        address: NATIVE_TOKEN_ADDRESS,
        type: "NATIVE",
        logoURI:
            "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/binance/info/logo.png",
    },
    [Chains.polygon]: {
        chainId: Chains.polygon,
        name: "Polygon",
        symbol: "MATIC",
        decimals: 18,
        address: NATIVE_TOKEN_ADDRESS,
        type: "NATIVE",
        logoURI:
            "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/polygon/info/logo.png",
    },
    [Chains.base]: {
        chainId: Chains.base,
        name: "Ethereum",
        symbol: "ETH",
        decimals: 18,
        address: NATIVE_TOKEN_ADDRESS,
        type: "NATIVE",
        logoURI:
            "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/info/logo.png",
    },
    [Chains.arbitrum]: {
        chainId: Chains.arbitrum,
        name: "Ethereum",
        symbol: "ETH",
        decimals: 18,
        address: NATIVE_TOKEN_ADDRESS,
        type: "NATIVE",
        logoURI:
            "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/info/logo.png",
    },
    [Chains.avalanche]: {
        chainId: Chains.avalanche,
        name: "Avalanche",
        symbol: "AVAX",
        decimals: 18,
        address: NATIVE_TOKEN_ADDRESS,
        type: "NATIVE",
        logoURI:
            "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/avalanchec/info/logo.png",
    },
    [Chains.linea]: {
        chainId: Chains.linea,
        name: "Ethereum",
        symbol: "ETH",
        decimals: 18,
        address: NATIVE_TOKEN_ADDRESS,
        type: "NATIVE",
        logoURI:
            "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/linea/info/logo.png",
    },
    [Chains.scroll]: {
        chainId: Chains.scroll,
        name: "Ethereum",
        symbol: "ETH",
        decimals: 18,
        address: NATIVE_TOKEN_ADDRESS,
        type: "NATIVE",
        logoURI:
            "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/scroll/info/logo.png",
    },
    [Chains.blast]: {
        chainId: Chains.blast,
        name: "Ethereum",
        symbol: "ETH",
        decimals: 18,
        address: NATIVE_TOKEN_ADDRESS,
        type: "NATIVE",
        logoURI:
            "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/blast/info/logo.png",
    },
};
