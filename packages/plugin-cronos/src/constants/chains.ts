import { defineChain } from "viem";

export const cronos = defineChain({
    id: 25,
    name: "Cronos Mainnet",
    nativeCurrency: {
        decimals: 18,
        name: "cronos",
        symbol: "CRO",
    },
    rpcUrls: {
        default: {
            http: ["https://evm.cronos.org/"],
        },
        public: {
            http: ["https://evm.cronos.org/"],
        },
    },
    blockExplorers: {
        default: {
            name: "Cronos Explorer",
            url: "https://explorer.cronos.org/",
        },
    },
    testnet: false,
});

export const cronosTestnet = defineChain({
    id: 338,
    name: "cronos-testnet",
    nativeCurrency: {
        decimals: 18,
        name: "Cronos",
        symbol: "TCRO",
    },
    rpcUrls: {
        default: {
            http: ["https://evm-t3.cronos.org/"],
        },
        public: {
            http: ["https://evm-t3.cronos.org/"],
        },
    },
    blockExplorers: {
        default: {
            name: "Cronos Explorer",
            url: "https://cronos.org/explorer/testnet3",
        },
    },
    testnet: true,
});