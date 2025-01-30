import { defineChain } from "viem";
import { mainnet } from "viem/chains";
import { chainConfig } from "viem/op-stack";

export default defineChain({
    ...chainConfig,
    id: 478,
    name: "Form",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: {
        default: { http: ["https://rpc.form.network/http"] },
    },
    blockExplorers: {
        default: {
            name: "Form Explorer",
            url: "https://explorer.form.network/",
        },
    },
    contracts: {
        addressManager: {
            [mainnet.id]: {
                address: "0x15c249E46A2F924C2dB3A1560CF86729bAD1f07B",
            },
        },
        l1CrossDomainMessenger: {
            [mainnet.id]: {
                address: "0xF333158DCCad1dF6C3F0a3aEe8BC31fA94d9eD5c",
            },
        },
        l2OutputOracle: {
            [mainnet.id]: {
                address: "0x4ccAAF69F41c5810cA875183648B577CaCf1F67E",
            },
        },
        portal: {
            [mainnet.id]: {
                address: "0x4E259Ee5F4136408908160dD32295A5031Fa426F",
            },
        },
        l1StandardBridge: {
            [mainnet.id]: {
                address: "0xdc20aA63D3DE59574E065957190D8f24e0F7B8Ba",
            },
        },
    },
});
