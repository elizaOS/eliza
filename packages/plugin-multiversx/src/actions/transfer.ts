import {
    elizaLogger,
    type ActionExample,
    type Content,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
    composeContext,
    generateObject,
    type Action,
} from "@elizaos/core";
import { WalletProvider } from "../providers/wallet";
import { validateMultiversxConfig } from "../enviroment";
import { transferSchema } from "../utils/schemas";
import { GraphqlProvider } from "../providers/graphql";
import { MVX_NETWORK_CONFIG } from "../constants";
import { NativeAuthProvider } from "../providers/nativeAuth";
import { getToken } from "../utils/getToken";
export interface TransferContent extends Content {
    tokenAddress: string;
    amount: string;
    tokenIdentifier?: string;
}
import { isUserAuthorized } from "../utils/accessTokenManagement";

const transferTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "tokenAddress": "erd12r22hx2q4jjt8e0gukxt5shxqjp9ys5nwdtz0gpds25zf8qwtjdqyzfgzm",
    "amount": "1",
    "tokenIdentifier": "PEPE-3eca7c"
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested token transfer:
- Token address
- Amount to transfer
- Token identifier

Respond with a JSON markdown block containing only the extracted values.`;

export default {
    name: "SEND_TOKEN",
    similes: [
        "TRANSFER_TOKEN",
        "TRANSFER_TOKENS",
        "SEND_TOKENS",
        "SEND_EGLD",
        "PAY",
    ],
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        elizaLogger.log("Validating config for user:", message.userId);
        await validateMultiversxConfig(runtime);
        return true;
    },
    description: "Transfer tokens from the agent wallet to another address",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback,
    ) => {
        elizaLogger.log("Starting SEND_TOKEN handler...");

        elizaLogger.log("Handler initialized. Checking user authorization...");

        if (!isUserAuthorized(message.userId, runtime)) {
            elizaLogger.error(
                "Unauthorized user attempted to transfer a token:",
                message.userId
            );
            if (callback) {
                callback({
                    text: "You do not have permission to transfer a token.",
                    content: { error: "Unauthorized user" },
                });
            }
            return false;
        }

        // Initialize or update state
        // if (!state) {
        //     state = (await runtime.composeState(message)) as State;
        // } else {
        //     state = await runtime.updateRecentMessageState(state);
        // }

        let currentState: State;
        if (!state) {
            currentState = (await runtime.composeState(message)) as State;
        } else {
            currentState = await runtime.updateRecentMessageState(state);
        }

        // Compose transfer context
        const transferContext = composeContext({
            state: currentState,
            template: transferTemplate,
        });

        // Generate transfer content
        const content = await generateObject({
            runtime,
            context: transferContext,
            modelClass: ModelClass.SMALL,
            schema: transferSchema,
        });

        const transferContent = content.object as TransferContent;
        const isTransferContent =
            typeof transferContent.tokenAddress === "string" &&
            typeof transferContent.amount === "string";

        // Validate transfer content
        if (!isTransferContent) {
            elizaLogger.error("Invalid content for TRANSFER_TOKEN action.");
            if (callback) {
                callback({
                    text: "Unable to process transfer request. Invalid content provided.",
                    content: { error: "Invalid transfer content" },
                });
            }
            return false;
        }

        try {
            const privateKey = runtime.getSetting("MVX_PRIVATE_KEY");
            const network = runtime.getSetting("MVX_NETWORK");
            const networkConfig = MVX_NETWORK_CONFIG[network];

            const walletProvider = new WalletProvider(privateKey, network);

            if (
                transferContent.tokenIdentifier &&
                transferContent.tokenIdentifier.toLowerCase() !== "egld"
            ) {
                const [ticker, nonce] =
                    transferContent.tokenIdentifier.split("-");

                let identifier = transferContent.tokenIdentifier;
                if (!nonce) {
                    const nativeAuthProvider = new NativeAuthProvider({
                        apiUrl: networkConfig.apiURL,
                    });

                    await nativeAuthProvider.initializeClient();

                    const accessToken =
                        await nativeAuthProvider.getAccessToken(walletProvider);

                    const graphqlProvider = new GraphqlProvider(
                        networkConfig.graphURL,
                        { Authorization: `Bearer ${accessToken}` },
                    );

                    const token = await getToken({
                        provider: graphqlProvider,
                        ticker,
                    });

                    identifier = token.identifier;
                }

                const txHash = await walletProvider.sendESDT({
                    receiverAddress: transferContent.tokenAddress,
                    amount: transferContent.amount,
                    identifier,
                });

                const txURL = walletProvider.getTransactionURL(txHash);
                callback?.({
                    text: `Transaction sent successfully! You can view it here: ${txURL}.`,
                });

                return true;
            }

            const txHash = await walletProvider.sendEGLD({
                receiverAddress: transferContent.tokenAddress,
                amount: transferContent.amount,
            });

            const txURL = walletProvider.getTransactionURL(txHash);
            callback?.({
                text: `Transaction sent successfully! You can view it here: ${txURL}.`,
            });

            return true;
        } catch (error) {
            elizaLogger.error("Error during token transfer:", error);
            callback?.({
                text: error.message,
                content: { error: error.message },
            });

            return "";
        }
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Send 1 EGLD to erd12r22hx2q4jjt8e0gukxt5shxqjp9ys5nwdtz0gpds25zf8qwtjdqyzfgzm",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll send 1 EGLD tokens now...",
                    action: "SEND_TOKEN",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Send 1 TST-a8b23d to erd12r22hx2q4jjt8e0gukxt5shxqjp9ys5nwdtz0gpds25zf8qwtjdqyzfgzm",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll send 1 TST-a8b23d tokens now...",
                    action: "SEND_TOKEN",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
