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
import { initWalletProvider, WalletProvider } from "../providers/wallet";

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

        let resp: FaucetResponse = {
            token: params.token!,
            recipient: params.toAddress!,
            txHash: "0x",
        };

        return new Promise((resolve, reject) => {
            const options: ClientOptions = {
                headers: {
                    Connection: "Upgrade",
                    Upgrade: "websocket",
                },
            };
            const ws = new WebSocket(this.FAUCET_URL, options);

            ws.onopen = () => {
                const message = {
                    tier: 0,
                    url: params.toAddress,
                    symbol: params.token,
                    captcha: "noCaptchaToken",
                };
                ws.send(JSON.stringify(message));
            };

            ws.onmessage = (event: WebSocket.MessageEvent) => {
                const response = JSON.parse(event.data.toString());

                // First response: funding request accepted
                if (response.success) {
                    return; // Wait for the next message
                }

                // Second response: transaction details
                if (response.requests && response.requests.length > 0) {
                    const txHash = response.requests[0].tx.hash;
                    if (txHash) {
                        resp.txHash = txHash as Hex;
                        resolve(resp);
                        ws.close();
                        return;
                    }
                }

                // Handle error case
                if (response.error) {
                    reject(new Error(response.error));
                    ws.close();
                }
            };

            ws.onerror = (error: WebSocket.ErrorEvent) => {
                reject(new Error(`WebSocket error occurred: ${error.message}`));
            };

            // Add timeout to prevent hanging
            setTimeout(() => {
                ws.close();
                reject(new Error("Faucet request timeout"));
            }, 15000); // 15 seconds timeout
        });
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
                user: "user",
                content: {
                    text: "Request some test tokens from the faucet on BSC Testnet",
                    action: "FAUCET",
                },
            },
        ],
    ],
    similes: ["FAUCET", "GET_TEST_TOKENS"],
};
