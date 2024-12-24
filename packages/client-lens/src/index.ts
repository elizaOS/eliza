import { Client, IAgentRuntime, elizaLogger } from "@elizaos/core";
import { privateKeyToAccount } from "viem/accounts";
import { LensClient } from "./client";
import { LensPostManager } from "./post";
import { LensInteractionManager } from "./interactions";
import {
    StorageProvider,
    StorageProviderEnum,
} from "./providers/StorageProvider";
import { StorjProvider } from "./providers/StorjProvider";
import { PinataProvider } from "./providers/PinataProvider";
import { ArweaveProvider } from "./providers/ArweaveProvider";

export class LensAgentClient implements Client {
    client: LensClient;
    posts: LensPostManager;
    interactions: LensInteractionManager;

    private profileId: `0x${string}`;
    private storage: StorageProvider;

    constructor(public runtime: IAgentRuntime) {
        const cache = new Map<string, any>();

        const privateKey = runtime.getSetting(
            "EVM_PRIVATE_KEY"
        ) as `0x${string}`;
        if (!privateKey) {
            throw new Error("EVM_PRIVATE_KEY is missing");
        }
        const account = privateKeyToAccount(privateKey);

        this.profileId = runtime.getSetting(
            "LENS_PROFILE_ID"
        )! as `0x${string}`;

        this.client = new LensClient({
            runtime: this.runtime,
            account,
            cache,
            profileId: this.profileId,
        });

        elizaLogger.info("Lens client initialized.");

        this.storage = this.getStorageProvider();

        this.posts = new LensPostManager(
            this.client,
            this.runtime,
            this.profileId,
            cache,
            this.storage
        );

        this.interactions = new LensInteractionManager(
            this.client,
            this.runtime,
            this.profileId,
            cache,
            this.storage
        );
    }

    private getStorageProvider(): StorageProvider {
        const storageProvider = this.runtime.getSetting(
            "LENS_STORAGE_PROVIDER"
        );

        const storageProviderMap = {
            [StorageProviderEnum.PINATA]: PinataProvider,
            [StorageProviderEnum.STORJ]: StorjProvider,
            [StorageProviderEnum.ARWEAVE]: ArweaveProvider,
        };

        let SelectedProvider =
            storageProviderMap[storageProvider as StorageProviderEnum];

        if (!SelectedProvider) {
            elizaLogger.info(
                "No valid storage provider specified, defaulting to Storj"
            );

            // Replace default provider with Lens Storage Nodes when on mainnet https://dev-preview.lens.xyz/docs/storage/using-storage
            SelectedProvider = StorjProvider;
        }
        const selected = new SelectedProvider(this.runtime);

        elizaLogger.info(
            `Using ${selected.provider} storage provider in Lens Client`
        );

        return selected;
    }

    async start() {
        if (this.storage.initialize) {
            await this.storage.initialize();
        }

        await Promise.all([this.posts.start(), this.interactions.start()]);
    }

    async stop() {
        await Promise.all([this.posts.stop(), this.interactions.stop()]);
    }
}
