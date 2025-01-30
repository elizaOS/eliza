import { defineChain } from "viem";
import { sepolia } from "viem/chains";
import { chainConfig } from "viem/op-stack";

export default defineChain({
    ...chainConfig,
    id: 132902,
    name: "Form Testnet",
    nativeCurrency: {
        decimals: 18,
        name: "Ether",
        symbol: "ETH",
    },
    rpcUrls: {
        default: { http: ["https://sepolia-rpc.form.network/http"] },
    },
    blockExplorers: {
        default: {
            name: "Form Testnet Explorer",
            url: "https://sepolia-explorer.form.network/",
        },
    },
    contracts: {
        addressManager: {
            [sepolia.id]: {
                address: "0xd5C38fa934f7fd7477D4800F4f38a1c5BFdF1373",
            },
        },
        l1CrossDomainMessenger: {
            [sepolia.id]: {
                address: "0x37A68565c4BE9700b3E3Ec60cC4416cAC3052FAa",
            },
        },
        l2OutputOracle: {
            [sepolia.id]: {
                address: "0x9eA2239E65a59EC9C7F1ED4C116dD58Da71Fc1e2",
            },
        },
        portal: {
            [sepolia.id]: {
                address: "0x60377e3cE15dF4CCA24c4beF076b60314240b032",
            },
        },
        l1StandardBridge: {
            [sepolia.id]: {
                address: "0xD4531f633942b2725896F47cD2aFd260b44Ab1F7",
            },
        },
    },
});
