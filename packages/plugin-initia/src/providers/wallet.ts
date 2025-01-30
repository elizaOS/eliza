import type { IAgentRuntime, Provider, Memory, State } from "@elizaos/core";

// Add type imports for Initia.js
import type { Wallet, RESTClient, Tx } from '@initia/initia.js';

interface WalletProviderOptions {
    chainId: string;
    nodeUrl: string;
}

const DEFAULT_INITIA_TESTNET_CONFIGS: WalletProviderOptions = {
    chainId: 'initiation-2',
    nodeUrl: 'https://rest.testnet.initia.xyz',
}

export class WalletProvider {
    private wallet: Wallet | null = null;
    private restClient: RESTClient | null = null;
    private runtime: IAgentRuntime;

    async initialize(runtime: IAgentRuntime, options: WalletProviderOptions = DEFAULT_INITIA_TESTNET_CONFIGS) {
        const privateKey = runtime.getSetting("INITIA_PRIVATE_KEY");
        if (!privateKey) throw new Error("INITIA_PRIVATE_KEY is not configured");

        const initia = await import('@initia/initia.js');
        const { Wallet, RESTClient, RawKey } = initia;

        this.runtime = runtime;
        this.restClient = new RESTClient(
            options.nodeUrl, {
                chainId: options.chainId,
                gasPrices: '0.15uinit',
                gasAdjustment: '1.75'
            });
        this.wallet = new Wallet(this.restClient, RawKey.fromHex(privateKey));
    }

    constructor(runtime: IAgentRuntime, options: WalletProviderOptions = DEFAULT_INITIA_TESTNET_CONFIGS) {
        this.runtime = runtime;
        this.initialize(runtime, options);
    }

    getWallet() {
        if (this.wallet == null) {
            throw new Error("Initia wallet is not configured.");
        }
        return this.wallet;
    }

    getAddress() {
        if (this.wallet == null) {
            throw new Error("Initia wallet is not configured.");
        }
        return this.wallet.key.accAddress;
    }

    async getBalance() {
        if (this.wallet == null) {
            throw new Error("Initia wallet is not configured.");
        }
        return this.wallet.rest.bank.balance(this.getAddress());
    }

    async sendTransaction(signedTx: Tx | string) {
        return await this.restClient.tx.broadcast(signedTx);
    }
}

export const initiaWalletProvider: Provider = {
    async get(runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<string | null> {
        if (!runtime.getSetting("INITIA_PRIVATE_KEY")) {
            return null;
        }

        try {
            const nodeUrl: string | null = runtime.getSetting("INITIA_NODE_URL");
            const chainId: string | null = runtime.getSetting("INITIA_CHAIN_ID");
            let walletProvider: WalletProvider;
            if (nodeUrl === null || chainId === null) {
                walletProvider = new WalletProvider(runtime);
            } else {
                walletProvider = new WalletProvider(runtime, { nodeUrl: nodeUrl, chainId: chainId } as WalletProviderOptions);
            }

            const address = walletProvider.getAddress();
            const balance = await walletProvider.getBalance();
            return `Initia Wallet Address: ${address}\nBalance: ${balance} INIT`;
        } catch (e) {
            console.error("Error during configuring initia wallet provider", e);
            return null;
        }
    }
}
