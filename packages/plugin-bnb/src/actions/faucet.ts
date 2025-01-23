import {
    composeContext,
    elizaLogger,
    generateObjectDeprecated,
    HandlerCallback,
    ModelClass,
    type IAgentRuntime,
    type Memory,
    type State,
} from "@elizaos/core";
import { type Hex } from "viem";
import WebSocket, { ClientOptions } from "ws";

import { faucetTemplate } from "../templates";
import { FaucetResponse, type FaucetParams } from "../types";
import {
    bnbWalletProvider,
    initWalletProvider,
    WalletProvider,
} from "../providers/wallet";

export { faucetTemplate };

// Exported for tests
export class FaucetAction {
    private readonly SUPPORTED_TOKENS: string[] = [
        "BNB",
        "BTC",
        "BUSD",
        "DAI",
        "ETH",
        "USDC",
    ] as const;
    private readonly FAUCET_URL = "wss://testnet.bnbchain.org/faucet-smart/api";

    constructor(private walletProvider: WalletProvider) {}

    async faucet(params: FaucetParams): Promise<FaucetResponse> {
        elizaLogger.debug("Faucet params:", params);
        await this.validateAndNormalizeParams(params);
        elizaLogger.debug("Normalized faucet params:", params);

        const resp: FaucetResponse = {
            token: params.token!,
            recipient: params.toAddress!,
            txHash: "0x",
        };

        const options: ClientOptions = {
            headers: {
                Connection: "Upgrade",
                Upgrade: "websocket",
            },
        };

        const ws = new WebSocket(this.FAUCET_URL, options);

        try {
            // Wait for connection
            await new Promise<void>((resolve, reject) => {
                ws.once("open", () => resolve());
                ws.once("error", reject);
            });

            // Send the message
            const message = {
                tier: 0,
                url: params.toAddress,
                symbol: params.token,
                captcha: "noCaptchaToken",
            };
            ws.send(JSON.stringify(message));

            // Wait for response with transaction hash
            const txHash = await new Promise<Hex>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    ws.close();
                    reject(new Error("Faucet request timeout"));
                }, 15000);

                ws.on("message", (data) => {
                    const response = JSON.parse(data.toString());

                    // First response: funding request accepted
                    if (response.success) {
                        return;
                    }

                    // Second response: transaction details
                    if (response.requests?.length > 0) {
                        const txHash = response.requests[0].tx.hash;
                        if (txHash) {
                            clearTimeout(timeout);
                            resolve(txHash as Hex);
                        }
                    }

                    // Handle error case
                    if (response.error) {
                        clearTimeout(timeout);
                        reject(new Error(response.error));
                    }
                });

                ws.on("error", (error) => {
                    clearTimeout(timeout);
                    reject(
                        new Error(`WebSocket error occurred: ${error.message}`)
                    );
                });
            });

            resp.txHash = txHash;
            return resp;
        } finally {
            ws.close();
        }
    }

    async validateAndNormalizeParams(params: FaucetParams): Promise<void> {
        if (!params.toAddress) {
            params.toAddress = this.walletProvider.getAddress();
        } else {
            params.toAddress = await this.walletProvider.formatAddress(
                params.toAddress
            );
        }

        if (!params.token) {
            params.token = "BNB";
        }
        if (!this.SUPPORTED_TOKENS.includes(params.token!)) {
            throw new Error("Unsupported token");
        }
    }
}

export const faucetAction = {
    name: "faucet",
    description: "Get test tokens from the faucet",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: any,
        callback?: HandlerCallback
    ) => {
        elizaLogger.log("Starting faucet action...");

        // Initialize or update state
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }
        state.walletInfo = await bnbWalletProvider.get(runtime, message, state);

        // Compose faucet context
        const faucetContext = composeContext({
            state,
            template: faucetTemplate,
        });
        const content = await generateObjectDeprecated({
            runtime,
            context: faucetContext,
            modelClass: ModelClass.LARGE,
        });

        const walletProvider = initWalletProvider(runtime);
        const action = new FaucetAction(walletProvider);
        const paramOptions: FaucetParams = {
            token: content.token,
            toAddress: content.toAddress,
        };
        try {
            const faucetResp = await action.faucet(paramOptions);
            callback?.({
                text: `Successfully transferred ${faucetResp.token} to ${faucetResp.recipient}\nTransaction Hash: ${faucetResp.txHash}`,
                content: {
                    hash: faucetResp.txHash,
                    recipient: faucetResp.recipient,
                    chain: content.chain,
                },
            });

            return true;
        } catch (error) {
            elizaLogger.error("Error during faucet:", error.message);
            callback?.({
                text: `Get test tokens failed: ${error.message}`,
                content: { error: error.message },
            });
            return false;
        }
    },
    template: faucetTemplate,
    validate: async (_runtime: IAgentRuntime) => {
        return true;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Get some USDC from the faucet",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Sure, I'll request some USDC from the faucet on BSC Testnet now.",
                    action: "FAUCET",
                    content: {
                        token: "USDC",
                        toAddress: "{{walletAddress}}",
                    },
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Get some test tokens from the faucet on BSC Testnet",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Of course, getting tBNB from the faucet on BSC Testnet now.",
                    action: "FAUCET",
                    content: {
                        token: "BNB",
                        toAddress: "{{walletAddress}}",
                    },
                },
            },
        ],
    ],
    similes: ["FAUCET", "GET_TEST_TOKENS"],
};
