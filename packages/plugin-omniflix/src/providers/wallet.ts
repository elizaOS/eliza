import { elizaLogger, IAgentRuntime, Provider } from "@elizaos/core";
import {
    DirectSecp256k1HdWallet,
    DirectSecp256k1Wallet,
} from "@cosmjs/proto-signing";
import { SigningStargateClient, Coin, GasPrice } from "@cosmjs/stargate";
import { fromHex } from "@cosmjs/encoding";

export class WalletProvider {
    private wallet: DirectSecp256k1HdWallet | DirectSecp256k1Wallet;
    private client: SigningStargateClient;

    constructor(
        wallet: DirectSecp256k1HdWallet | DirectSecp256k1Wallet,
        client: SigningStargateClient
    ) {
        this.wallet = wallet;
        this.client = client;
    }

    async getBalance(address: string): Promise<Coin[]> {
        const balance = await this.client.getBalance(address, "uflix");
        return [balance];
    }

    async getClient(): Promise<SigningStargateClient> {
        return this.client;
    }

    async getWallet(): Promise<
        DirectSecp256k1HdWallet | DirectSecp256k1Wallet
    > {
        return this.wallet;
    }

    async getAddress(): Promise<string> {
        const address = await this.wallet.getAccounts();
        return address[0].address;
    }

    async getMnemonic(): Promise<string | undefined> {
        if (this.wallet instanceof DirectSecp256k1HdWallet) {
            return this.wallet.mnemonic;
        }
        return undefined;
    }
}

export const walletProvider: Provider = {
    get: async (runtime: IAgentRuntime) => {
        try {
            const privateKey =
                runtime.getSetting("privateKey") ||
                process.env.OMNIFLIX_PRIVATE_KEY;
            const mnemonic =
                runtime.getSetting("mnemonic") || process.env.OMNIFLIX_MNEMONIC;
            const rpcEndpoint =
                runtime.getSetting("rpcEndpoint") ||
                process.env.OMNIFLIX_RPC_ENDPOINT;

            if (!rpcEndpoint) {
                elizaLogger.error("RPC endpoint not found");
                return null;
            }

            if (!privateKey && !mnemonic) {
                elizaLogger.error("Neither private key nor mnemonic provided");
                return null;
            }

            let wallet: DirectSecp256k1HdWallet | DirectSecp256k1Wallet;

            if (privateKey) {
                // Convert hex private key to Uint8Array
                const privateKeyBytes = fromHex(
                    privateKey.startsWith("0x")
                        ? privateKey.slice(2)
                        : privateKey
                );
                wallet = await DirectSecp256k1Wallet.fromKey(
                    privateKeyBytes,
                    "omniflix"
                );
                elizaLogger.info("Wallet initialized with private key");
            } else if (mnemonic) {
                // Use mnemonic
                wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
                    prefix: "omniflix",
                });
                elizaLogger.info("Wallet initialized with mnemonic");
            } else {
                throw new Error("Neither private key nor mnemonic available");
            }

            const client = await SigningStargateClient.connectWithSigner(
                rpcEndpoint,
                wallet,
                {
                    gasPrice: GasPrice.fromString("0.025uflix"),
                }
            );

            return new WalletProvider(wallet, client);
        } catch (error) {
            elizaLogger.error(`Error initializing wallet: ${error.message}`);
            return null;
        }
    },
};

export default walletProvider;
