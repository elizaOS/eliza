import { StoreMemory } from '@web3-storage/w3up-client/stores/memory';
import { Signer } from '@ucanto/principal/ed25519';
import { StorageClientConfig } from './environments';
import * as Storage from '@web3-storage/w3up-client';
import { parseDelegation } from './utils';

export const createStorageClient = async (config: StorageClientConfig): Promise<Storage.Client> => {
    if (!config.STORACHA_AGENT_PRIVATE_KEY) {
        throw new Error("Agent private key is missing from the storage client configuration");
    }
    if (!config.STORACHA_AGENT_DELEGATION) {
        throw new Error("Agent delegation is missing from the storage client configuration");
    }

    const principal = Signer.parse(config.STORACHA_AGENT_PRIVATE_KEY);
    const store = new StoreMemory();
    const client = await Storage.create({ principal, store });

    const delegationProof = await parseDelegation(config.STORACHA_AGENT_DELEGATION);
    const space = await client.addSpace(delegationProof);
    await client.setCurrentSpace(space.did());
    console.log(`Storage client initialized`);

    return client;
}
