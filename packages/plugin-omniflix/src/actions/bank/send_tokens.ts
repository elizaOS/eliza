import {
    elizaLogger,
    composeContext,
    Content,
    HandlerCallback,
    ModelClass,
    type Memory,
    type State,
    generateObjectDeprecated,
    ActionExample,
    Action,
    IAgentRuntime,
} from "@elizaos/core";
import { WalletProvider, walletProvider } from "../../providers/wallet.ts";
import { BankProvider } from "../../providers/bank.ts";
import { bech32 } from "bech32";
import sendTokensExamples from "../../action_examples/bank/send_tokens";

export interface SendTokensContent extends Content {
    recipient: string;
    amount: string | number;
    denom: string;
}

interface validationResult {
    success: boolean;
    message: string;
}

function isSendTokensContent(content: Content): validationResult {
    let msg = "";
    if (!content.recipient) {
        msg += "Please provide a recipient address for the transfer request.";
    } else {
        try {
            const { prefix } = bech32.decode(content.recipient as string);
            if (prefix !== "omniflix") {
                msg +=
                    "Please provide a valid Omniflix address for the transfer request.";
            }
        } catch {
            msg +=
                "Please provide a valid Omniflix address for the transfer request.";
        }
    }
    if (!content.amount) {
        msg += "Please provide an amount for the transfer request.";
    }
    if (!content.denom) {
        msg += "Please provide a denom for the transfer request.";
    }
    if (msg !== "") {
        return {
            success: false,
            message: msg,
        };
    }
    return {
        success: true,
        message: "Transfer request is valid.",
    };
}

const sendTokensTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "recipient": "omniflix1abc123...",
    "amount": "100",
    "denom": "uflix",
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested token transfer:
- recipient wallet address mentioned in the current message
- amount to transfer mentioned in the current message
- denom (uflix/FLIX/flix) mentioned in the current message

Respond with a JSON markdown block containing only the extracted values.`;

export class SendTokensAction {
    async transfer(
        params: SendTokensContent,
        runtime: IAgentRuntime,
        message: Memory,
        state: State
    ): Promise<string> {
        try {
            const wallet: WalletProvider = await walletProvider.get(
                runtime,
                message,
                state
            );
            const bankProvider = new BankProvider(wallet);
            let url =
                runtime.getSetting("OMNIFLIX_API_URL") ||
                process.env.OMNIFLIX_API_URL;
            if (!url) {
                url = "https://rest.omniflix.network";
            }

            if (params.denom === "FLIX" || params.denom === "flix") {
                params.denom = "uflix";
                if (typeof params.amount === "number") {
                    params.amount = params.amount * 1000000;
                } else if (typeof params.amount === "string") {
                    params.amount = Number.parseInt(params.amount) * 1000000;
                }
            }

            const txHash = await bankProvider.sendTokens(params.recipient, {
                amount: params.amount.toString(),
                denom: params.denom,
            });

            return txHash.transactionHash;
        } catch (error) {
            throw new Error(`Transfer failed: ${error.message}`);
        }
    }
}

const buildTransferDetails = async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State
): Promise<SendTokensContent> => {

    // if (!state) {
    //     state = (await runtime.composeState(message)) as State;
    // } else {
    //     state = await runtime.updateRecentMessageState(state);
    // }
    
    let currentState: State = state;
    if (!currentState) {
        currentState = (await runtime.composeState(message)) as State;
    }
    currentState = await runtime.updateRecentMessageState(currentState);

    const transferContext = composeContext({
        state: currentState,
        template: sendTokensTemplate,
    });

    const content = await generateObjectDeprecated({
        runtime,
        context: transferContext,
        modelClass: ModelClass.SMALL,
    });

    const transferContent = content as SendTokensContent;

    return transferContent;
};

export default {
    name: "SEND_TOKENS",
    similes: [
        "send tokens",
        "send FLIX",
        "send FLIX to {address}",
        "send FLIX to {address} from my omniflix address",
        "send {amount} FLIX to {address}",
        "send {amount} FLIX to {address} from my omniflix address",
    ],
    description: "Send tokens to a specified omniflix address.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ) => {
        elizaLogger.log("Starting SEND_TOKENS handler...");

        const transferDetails = await buildTransferDetails(
            runtime,
            message,
            state
        );

        const validationResult = isSendTokensContent(transferDetails);

        if (!validationResult.success) {
            if (callback) {
                callback({
                    text: validationResult.message,
                    content: { error: validationResult.message },
                });
            }
            return false;
        }

        try {
            const action = new SendTokensAction();
            const txHash = await action.transfer(
                transferDetails,
                runtime,
                message,
                state
            );

            state = await runtime.updateRecentMessageState(state);

            if (callback) {
                let displayAmount = transferDetails.amount;
                let displayDenom = transferDetails.denom;

                if (transferDetails.denom === "uflix") {
                    displayAmount =
                        (transferDetails.amount as number) / 1000000;
                    displayDenom = "FLIX";
                }

                callback({
                    text: `Successfully transferred ${displayAmount} ${displayDenom} to ${transferDetails.recipient}, Transaction: ${txHash}`,
                    content: {
                        success: true,
                        hash: txHash,
                        amount: displayAmount,
                        recipient: transferDetails.recipient,
                        denom: displayDenom,
                        ...transferDetails,
                    },
                });
            }
            return true;
        } catch (error) {
            if (callback) {
                callback({
                    text: `Error transferring tokens: ${error.message}`,
                    content: { error: error.message },
                });
            }
            return false;
        }
    },
    template: sendTokensTemplate,
    validate: async (_runtime: IAgentRuntime) => {
        return true;
    },
    examples: sendTokensExamples as ActionExample[][],
} as Action;
