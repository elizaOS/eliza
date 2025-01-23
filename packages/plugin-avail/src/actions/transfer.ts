import {
    type ActionExample,
    type Content,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
    type Action,
    elizaLogger,
    composeContext,
    generateObjectDeprecated,
} from "@elizaos/core";
import { validateAvailConfig } from "../environment";
import {
    getDecimals,
    initialize,
    formatNumberToBalance,
    getKeyringFromSeed,
    isValidAddress,
} from "avail-js-sdk";
import type { ISubmittableResult } from "@polkadot/types/types/extrinsic";
import type { H256 } from "@polkadot/types/interfaces/runtime";

export interface TransferContent extends Content {
    recipient: string;
    amount: string | number;
}

export function isTransferContent(
    content: TransferContent
): content is TransferContent {
    // Validate types
    const validTypes =
        typeof content.recipient === "string" &&
        (typeof content.amount === "string" ||
            typeof content.amount === "number");
    if (!validTypes) {
        return false;
    }

    // Validate addresses
    const validAddresses = isValidAddress(content.recipient);
    return validAddresses;
}

const transferTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.


Example response:
\`\`\`json
{
    "recipient": "5GWbvXjefEvXXETtKQH7YBsUaPc379KAQATW1eqeJT26cbsK",
    "amount": "1000"
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested AVAIL token transfer:
- Recipient wallet address
- Amount of AVAIL to transfer

Respond with a JSON markdown block containing only the extracted values.`;

export default {
    name: "SEND_AVAIL",
    similes: [
        "TRANSFER_AVAIL_TOKEN",
        "TRANSFER_TOKEN",
        "TRANSFER_TOKENS_ON_AVAIL",
        "TRANSFER_TOKEN_ON_AVAIL",
        "SEND_TOKENS_ON_AVAIL",
        "SEND_TOKENS_ON_AVAIL_NETWORK",
        "SEND_AVAIL_ON_AVAIL_NETWORK",
        "SEND_AVAIL_TOKEN_ON_AVAIL_DA",
        "PAY_ON_AVAIL",
    ],
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        await validateAvailConfig(runtime);
        return true;
    },
    description:
        "Transfer AVAIL tokens from the agent's wallet to another address",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting SEND_TOKEN handler...");

        // Initialize or update state
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        // Compose transfer context
        const transferContext = composeContext({
            state,
            template: transferTemplate,
        });

        // Generate transfer content
        const content = await generateObjectDeprecated({
            runtime,
            context: transferContext,
            modelClass: ModelClass.SMALL,
        });

        // Validate transfer content
        if (!isTransferContent(content)) {
            console.log(content);
            console.error("Invalid content for TRANSFER_TOKEN action.");
            if (callback) {
                callback({
                    text: "Unable to process transfer request. Invalid content provided.",
                    content: { error: "Invalid transfer content" },
                });
            }
            return false;
        }

        if (content.amount != null && content.recipient != null) {
            try {
                const SEED = runtime.getSetting("AVAIL_SEED")!;
                //const PUBLIC_KEY = runtime.getSetting("AVAIL_ADDRESS")!;
                const ENDPOINT = runtime.getSetting("AVAIL_RPC_URL");

                const api = await initialize(ENDPOINT);
                const keyring = getKeyringFromSeed(SEED);
                const options = { app_id: 0, nonce: -1 };
                const decimals = getDecimals(api);
                const amount = formatNumberToBalance(content.amount, decimals);

                const oldBalance: any = await api.query.system.account(
                    content.recipient
                );
                elizaLogger.log(
                    `Balance before the transfer call: ${oldBalance["data"]["free"].toHuman()}`
                );

                // Transaction call
                const txResult:ISubmittableResult = await new Promise(
                    (res) => {
                        api.tx.balances
                            .transferKeepAlive(content.recipient, amount)
                            .signAndSend(
                                keyring,
                                options,
                                (result) => {
                                    elizaLogger.log(
                                        `Tx status: ${result.status}`
                                    );
                                    if (result.isFinalized || result.isError) {
                                        res(result as any);
                                    }
                                }
                            );
                    }
                );

                // Error handling
                const error = txResult.dispatchError;
                if (txResult.isError) {
                    elizaLogger.log(`Transaction was not executed`);
                } else if (error != undefined) {
                    if (error.isModule) {
                        const decoded = api.registry.findMetaError(
                            error.asModule
                        );
                        const { docs, name, section } = decoded;
                        elizaLogger.log(
                            `${section}.${name}: ${docs.join(" ")}`
                        );
                    } else {
                        elizaLogger.log(error.toString());
                    }
                }

                const newBalance: any = await api.query.system.account(
                    content.recipient
                );
                elizaLogger.log(
                    `Balance after the transfer call: ${newBalance["data"]["free"].toHuman()}`
                );

                elizaLogger.success(
                    "Transfer completed successfully! tx: \n " +
                        `Tx Hash: ${txResult.txHash as H256}, Block Hash: ${txResult.status.asFinalized as H256}`
                );
                if (callback) {
                    callback({
                        text: `Transfer completed successfully! tx hash: ${txResult.txHash as H256} Block Hash: ${txResult.status.asFinalized as H256} `,
                        content: {},
                    });
                }

                return true;
            } catch (error) {
                elizaLogger.error("Error during token transfer:", error);
                if (callback) {
                    callback({
                        text: `Error transferring tokens: ${error.message}`,
                        content: { error: error.message },
                    });
                }
                return false;
            }
        } else {
            elizaLogger.log("Either amount or recipient not specified");
        }
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Send 100 AVAIL to 5GWbvXjefEvXXETtKQH7YBsUaPc379KAQATW1eqeJT26cbsK",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Sure, I'll send 100 AVAIL to that address now.",
                    action: "SEND_AVAIL",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully sent 100 AVAIL to 5GWbvXjefEvXXETtKQH7YBsUaPc379KAQATW1eqeJT26cbsK\nTransaction: 0x748057951ff79cea6de0e13b2ef70a1e9f443e9c83ed90e5601f8b45144a4ed4",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Please send 100 AVAIL tokens to 5GWbvXjefEvXXETtKQH7YBsUaPc379KAQATW1eqeJT26cbsK",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Of course. Sending 100 AVAIL to that address now.",
                    action: "SEND_TOKEN",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully sent 100 AVAIL to 5GWbvXjefEvXXETtKQH7YBsUaPc379KAQATW1eqeJT26cbsK\nTransaction: 0x0b9f23e69ea91ba98926744472717960cc7018d35bc3165bdba6ae41670da0f0",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
