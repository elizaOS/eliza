import type { IAgentRuntime, Provider, Memory, State } from "@elizaos/core";
import {
    createPublicClient,
    createWalletClient,
    http,
    formatUnits,
    type PublicClient,
    type WalletClient,
    type Chain,
    type HttpTransport,
    type Address,
    type Account,
    type Transport,
} from "viem";
import { storyOdyssey } from "viem/chains";
import type { SupportedChain, ChainMetadata } from "../types";
import { privateKeyToAccount } from "viem/accounts";
import { StoryClient, type StoryConfig } from "@story-protocol/core-sdk";

export const DEFAULT_CHAIN_CONFIGS: Record<SupportedChain, ChainMetadata> = {
    odyssey: {
        chainId: 1516,
        name: "Odyssey Testnet",
        chain: storyOdyssey,
        rpcUrl: "https://odyssey.storyrpc.io/",
        nativeCurrency: {
            name: "IP",
            symbol: "IP",
            decimals: 18,
        },
        blockExplorerUrl: "https://odyssey.storyscan.xyz",
    },
} as const;

export class WalletProvider {
    private storyClient: StoryClient;
    private publicClient: PublicClient<
        HttpTransport,
        Chain,
        Account | undefined
    >;
    private walletClient: WalletClient;
    private address: Address;
    runtime: IAgentRuntime;

    constructor(runtime: IAgentRuntime) {
        const privateKey = runtime.getSetting("STORY_PRIVATE_KEY");
        if (!privateKey) throw new Error("STORY_PRIVATE_KEY not configured");

        this.runtime = runtime;

        const account = privateKeyToAccount(privateKey as Address);
        this.address = account.address;

        const config: StoryConfig = {
            account: account as Account,
            transport: http(DEFAULT_CHAIN_CONFIGS.odyssey.rpcUrl) as Transport,
            chainId: "odyssey",
        };
        this.storyClient = StoryClient.newClient(config);

        const baseConfig = {
            chain: storyOdyssey,
            transport: http(DEFAULT_CHAIN_CONFIGS.odyssey.rpcUrl),
        } as const;
        this.publicClient = createPublicClient<HttpTransport>(
            baseConfig
        ) as PublicClient<HttpTransport, Chain, Account | undefined>;

        this.walletClient = createWalletClient<HttpTransport>({
            chain: storyOdyssey,
            transport: http(DEFAULT_CHAIN_CONFIGS.odyssey.rpcUrl),
            account: account,
        });
    }

    getAddress(): Address {
        return this.address;
    }

    async getWalletBalance(): Promise<string | null> {
        try {
            const balance = await this.publicClient.getBalance({
                address: this.address,
            });
            return formatUnits(balance, 18);
        } catch (error) {
            console.error("Error getting wallet balance:", error);
            return null;
        }
    }

    async connect(): Promise<`0x${string}`> {
        return this.runtime.getSetting("STORY_PRIVATE_KEY") as `0x${string}`;
    }

    getPublicClient(): PublicClient<HttpTransport, Chain, Account | undefined> {
        return this.publicClient;
    }

    getWalletClient(): WalletClient {
        if (!this.walletClient) throw new Error("Wallet not connected");
        return this.walletClient;
    }

    getStoryClient(): StoryClient {
        if (!this.storyClient) throw new Error("StoryClient not connected");
        return this.storyClient;
    }
}

export const storyWalletProvider: Provider = {
    async get(
        runtime: IAgentRuntime,
// eslint-disable-next-line
        _message: Memory,
// eslint-disable-next-line
        _state?: State
    ): Promise<string | null> {
        // Check if the user has a Story wallet
        if (!runtime.getSetting("STORY_PRIVATE_KEY")) {
            return null;
        }

        try {
            const walletProvider = new WalletProvider(runtime);
            const address = walletProvider.getAddress();
            const balance = await walletProvider.getWalletBalance();
            return `Story Wallet Address: ${address}\nBalance: ${balance} IP`;
        } catch (error) {
            console.error("Error in Story wallet provider:", error);
            return null;
        }
    },
};
