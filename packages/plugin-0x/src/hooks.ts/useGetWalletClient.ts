import {
    createWalletClient,
    http,
    publicActions,
    createTestClient,
    WalletClient,
    PublicClient,
    walletActions,
} from "viem";

import {
    arbitrum,
    avalanche,
    base,
    blast,
    bsc,
    hardhat,
    linea,
    mainnet,
    optimism,
    polygon,
    scroll,
} from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const CHAIN_CONFIG = {
    1: {
        chain: mainnet,
        rpcUrl: process.env.ETH_RPC_URL,
    },
    10: {
        chain: optimism,
        rpcUrl: process.env.OPTIMISM_RPC_URL,
    },
    56: {
        chain: bsc,
        rpcUrl: process.env.BSC_RPC_URL,
    },
    137: {
        chain: polygon,
        rpcUrl: process.env.POLYGON_RPC_URL,
    },
    8453: {
        chain: base,
        rpcUrl: process.env.BASE_RPC_URL,
    },
    42161: {
        chain: arbitrum,
        rpcUrl: process.env.ARBITRUM_RPC_URL,
    },
    43114: {
        chain: avalanche,
        rpcUrl: process.env.AVALANCHE_RPC_URL,
    },
    59144: {
        chain: linea,
        rpcUrl: process.env.LINEA_RPC_URL,
    },
    534352: {
        chain: scroll,
        rpcUrl: process.env.SCROLL_RPC_URL,
    },
    81457: {
        chain: blast,
        rpcUrl: process.env.BLAST_RPC_URL,
    },
} as const;

export const getWalletClient = (
    chainId: number
): WalletClient & PublicClient => {
    const rawPrivateKey = process.env.WALLET_PRIVATE_KEY;
    if (!rawPrivateKey) {
        throw new Error("Wallet private key is required");
    }
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(rawPrivateKey)) {
        throw new Error("Invalid private key format");
    }
    const privateKey = rawPrivateKey.startsWith("0x")
        ? (rawPrivateKey as `0x${string}`)
        : (`0x${rawPrivateKey}` as `0x${string}`);

    const account = privateKeyToAccount(privateKey);

    if (process.env.NODE_ENV === "development") {
        return createTestClient({
            chain: hardhat,
            transport: http(),
            mode: "hardhat",
            account: privateKeyToAccount(
                process.env.WALLET_PRIVATE_KEY as `0x${string}`
            ),
        })
            .extend(walletActions)
            .extend(publicActions) as WalletClient & PublicClient;
    }

    const config = CHAIN_CONFIG[chainId as keyof typeof CHAIN_CONFIG];
    if (!config) throw new Error(`Chain ID ${chainId} not supported by 0x`);

    return createWalletClient({
        chain: config.chain,
        transport: http(config.rpcUrl),
        account,
    }).extend(publicActions) as WalletClient & PublicClient;
};
