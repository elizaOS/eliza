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
import { GraphqlProvider } from "../providers/graphql";
import { validateMultiversxConfig } from "../enviroment";
import { swapSchema } from "../utils/schemas";
import { MVX_NETWORK_CONFIG } from "../constants";
import { swapQuery } from "../graphql/swapQuery";
import { NativeAuthProvider } from "../providers/nativeAuth";
import {
    FungibleTokenOfAccountOnNetwork,
    Transaction,
    TransactionPayload,
} from "@multiversx/sdk-core/out";
import { denominateAmount, getRawAmount } from "../utils/amount";
import { getToken } from "../utils/getToken";
import { filteredTokensQuery } from "../graphql/tokensQuery";
import { isUserAuthorized } from "../utils/accessTokenManagement";


type SwapResultType = {
    swap: {
        noAuthTransactions: {
            value: string;
            receiver: string;
            gasPrice: bigint;
            gasLimit: bigint;
            data: TransactionPayload;
            chainID: string;
            version: number;
            sender: string;
            nonce: number;
        }[];
    };
};

export interface ISwapContent extends Content {
    tokenIn: string;
    amountIn: string;
    tokenOut: string;
}

const swapTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "tokenIn": "EGLD",
    "amountIn": "1",
    "tokenOut": "MEX"
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested token transfer:
- Source token
- Amount to transfer
- Destination token

Respond with a JSON markdown block containing only the extracted values.`;

export default {
    name: "SWAP",
    similes: ["SWAP_TOKEN", "SWAP_TOKENS"],
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        elizaLogger.log("Validating config for user:", message.userId);
        await validateMultiversxConfig(runtime);
        return true;
    },
    description: "Swap tokens",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback,
    ) => {
        elizaLogger.log("Starting SWAP handler...");

        elizaLogger.log("Handler initialized. Checking user authorization...");

                if (!isUserAuthorized(message.userId, runtime)) {
                    elizaLogger.error(
                        "Unauthorized user attempted to swap:",
                        message.userId
                    );
                    if (callback) {
                        callback({
                            text: "You do not have permission to swap.",
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
        const swapContext = composeContext({
            state: currentState,
            template: swapTemplate,
        });

        // Generate transfer content
        const content = await generateObject({
            runtime,
            context: swapContext,
            modelClass: ModelClass.SMALL,
            schema: swapSchema,
        });

        const swapContent = content.object as ISwapContent;

        const isSwapContent =
            typeof swapContent.tokenIn === "string" &&
            typeof swapContent.tokenOut === "string" &&
            typeof swapContent.amountIn === "string";

        // Validate transfer content
        if (!isSwapContent) {
            elizaLogger.error("Invalid content for SWAP action.");

            callback?.({
                text: "Unable to process swap request. Invalid content provided.",
                content: { error: "Invalid swap content" },
            });

            return false;
        }

        try {
            const privateKey = runtime.getSetting("MVX_PRIVATE_KEY");
            const network = runtime.getSetting("MVX_NETWORK");
            const networkConfig = MVX_NETWORK_CONFIG[network];
            const walletProvider = new WalletProvider(privateKey, network);
            const isEGLD = swapContent.tokenIn.toLowerCase() === "egld";

            const hasEgldBalance = await walletProvider.hasEgldBalance(
                isEGLD ? swapContent.amountIn : undefined,
            );

            if (!hasEgldBalance) {
                throw new Error("Insufficient balance.");
            }

            const nativeAuthProvider = new NativeAuthProvider({
                apiUrl: networkConfig.apiURL,
            });

            await nativeAuthProvider.initializeClient();
            const address = walletProvider.getAddress().toBech32();

            const accessToken =
                await nativeAuthProvider.getAccessToken(walletProvider);

            const graphqlProvider = new GraphqlProvider(
                networkConfig.graphURL,
                { Authorization: `Bearer ${accessToken}` },
            );

            let tokenData: FungibleTokenOfAccountOnNetwork = null;
            let tokenIn = swapContent.tokenIn;
            let tokenOut = swapContent.tokenOut;
            const [tickerOut, nonceOut] = swapContent.tokenOut.split("-");

            if (!isEGLD) {
                const [tickerIn, nonceIn] = swapContent.tokenIn.split("-");

                if (!nonceIn) {
                    const token = await getToken({
                        provider: graphqlProvider,
                        ticker: tickerIn,
                    });
                    tokenIn = token.identifier;
                }

                if (!nonceOut && tickerOut.toLowerCase() !== "egld") {
                    const token = await getToken({
                        provider: graphqlProvider,
                        ticker: tickerOut,
                    });
                    tokenOut = token.identifier;
                }

                tokenData = await walletProvider.getTokenData(tokenIn);

                const rawBalance = getRawAmount({
                    amount: tokenData.balance.toString(),
                    decimals: tokenData.rawResponse.decimals,
                });
                const rawBalanceNum = Number(rawBalance);

                if (rawBalanceNum < Number(swapContent.amountIn)) {
                    throw new Error("Insufficient balance");
                }
            }

            if (!nonceOut && tickerOut.toLowerCase() !== "egld") {
                const token = await getToken({
                    provider: graphqlProvider,
                    ticker: tickerOut,
                });
                tokenOut = token.identifier;
            }

            const value = denominateAmount({
                amount: swapContent.amountIn,
                decimals: isEGLD ? 18 : tokenData?.rawResponse?.decimals,
            });

            const variables = {
                amountIn: value,
                tokenInID: tokenIn,
                tokenOutID: tokenOut,
                tolerance: 0.01,
                sender: address,
            };

            const { swap } = await graphqlProvider.query<SwapResultType>(
                swapQuery,
                variables,
            );

            if (!swap.noAuthTransactions) {
                throw new Error("No route found");
            }

            const txURLs = await Promise.all(
                swap.noAuthTransactions.map(async (transaction) => {
                    const txToBroadcast = { ...transaction };
                    txToBroadcast.sender = address;
                    txToBroadcast.data = TransactionPayload.fromEncoded(
                        transaction.data as unknown as string,
                    );

                    const account = await walletProvider.getAccount(
                        walletProvider.getAddress(),
                    );
                    txToBroadcast.nonce = account.nonce;

                    const tx = new Transaction(txToBroadcast);
                    const signature = await walletProvider.signTransaction(tx);
                    tx.applySignature(signature);

                    const txHash = await walletProvider.sendTransaction(tx);
                    return walletProvider.getTransactionURL(txHash); // Return the transaction URL
                }),
            );

            const transactionURLs = txURLs.join(",");
            callback?.({
                text: `Transaction(s) sent successfully! You can view it here: ${transactionURLs}.`,
            });
            return true;
        } catch (error) {
            elizaLogger.error("Error during token swap:", error);
            callback?.({
                text: "Could not execute the swap.",
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
                    text: "Swap 1 EGLD for USDC",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Swapping 1 EGLD for USDC...",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
