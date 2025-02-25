import * as Storage from '@web3-storage/w3up-client';
import { StoreMemory } from '@web3-storage/w3up-client/stores/memory'
import { CarReader } from '@ipld/car'
import { importDAG } from '@ucanto/core/delegation'
import { StorageClientConfig } from '../environments';
import { Signer } from '@ucanto/principal/ed25519';

class StorageClientSingleton {
    private static instance: Promise<Storage.Client>;


    private constructor() {
        // Private constructor to prevent direct instantiation
    }

    public static getInstance(config: StorageClientConfig): Promise<Storage.Client> {
        if (!StorageClientSingleton.instance) {
            StorageClientSingleton.instance = (async () => {
                if (!config.STORACHA_AGENT_PRIVATE_KEY) {
                    throw new Error("Agent private key is missing from the storage client configuration");
                }
                if (!config.STORACHA_AGENT_DELEGATION) {
                    throw new Error("Agent delegation is missing from the storage client configuration");
                }

                const principal = Signer.parse(config.STORACHA_AGENT_PRIVATE_KEY);
                const store = new StoreMemory();
                const client = await Storage.create({ principal, store });

                const delegationProof = await this.parseDelegation(config.STORACHA_AGENT_DELEGATION);
                const space = await client.addSpace(delegationProof);
                await client.setCurrentSpace(space.did());
                console.log(`Storage client initialized`);

                return client;
            })().catch(error => {
                console.error("Storage client failed to initialize", error);
                // Clear the instance so it can be retried
                StorageClientSingleton.instance = null;
                throw error;
            });
        }

        return StorageClientSingleton.instance;
    }


    /**
     * Parses a delegation from a base64 encoded CAR file
     * @param data - The base64 encoded CAR file
     * @returns The parsed delegation
     */
    static async parseDelegation(data: string) {
        const blocks = []
        const reader = await CarReader.fromBytes(Buffer.from(data, 'base64'))
        for await (const block of reader.blocks()) {
            blocks.push(block)
        }
        return importDAG(blocks)
    }

}

export const getStorageClient = StorageClientSingleton.getInstance;
