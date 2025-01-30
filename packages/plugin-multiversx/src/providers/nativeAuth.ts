import { NativeAuthClient } from "@multiversx/sdk-native-auth-client";
import { WalletProvider } from "./wallet";

type NativeAuthClientConfigType = {
    origin?: string;
    apiUrl: string;
    expirySeconds?: number;
    blockHashShard?: number;
    gatewayUrl?: string;
    extraRequestHeaders?: { [key: string]: string };
};

export class NativeAuthProvider {
    private client: NativeAuthClient;
    public init: string;

    /**
     * Initialize the NativeAuth client with the given config.
     * @param config - The NativeAuth config.
     */
    constructor(config?: NativeAuthClientConfigType) {
        this.client = new NativeAuthClient(config);
    }

    /**
     * Initialize the client and store the result in the `init` property.
     */
    public async initializeClient() {
        this.init = await this.client.initialize();
    }

    /**
     * Get an access token using the initialized client.
     * @param address - The address of the user.
     * @param signature - The signature for authentication.
     * @returns The access token.
     */
    public async getAccessToken(provider: WalletProvider) {
        if (!this.init) {
            throw new Error(
                "Client is not initialized. Call initializeClient() first.",
            );
        }
        const address = provider.getAddress().toBech32();
        const message = `${address}${this.init}`;

        const signature = await provider.signMessage(message);

        return this.client.getToken(
            address,
            this.init,
            Buffer.from(signature).toString("hex"),
        );
    }
}
