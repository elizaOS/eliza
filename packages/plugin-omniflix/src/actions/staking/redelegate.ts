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
import { StakingProvider } from "../../providers/staking.ts";
import { bech32 } from "bech32";
import redelegateExamples from "../../action_examples/staking/redelegate.ts";

export interface RedelegateTokensContent extends Content {
    validator_src_address: string;
    validator_dst_address: string;
    amount: string | number;
    denom: string;
    memo: string;
}

interface validationResult {
    success: boolean;
    message: string;
}

function isRedelegateTokensContent(content: Content): validationResult {
    let msg = "";
    if (!content.validator_src_address) {
        msg +=
            "Please provide a validator source address for the redelegation request.";
    } else {
        try {
            const { prefix } = bech32.decode(
                content.validator_src_address as string
            );
            if (prefix !== "omniflixvaloper") {
                msg +=
                    "Please provide a valid Omniflix validator source address for the redelegation request.";
            }
        } catch {
            msg +=
                "Please provide a valid Omniflix validator source address for the redelegation request.";
        }
    }
    if (!content.validator_dst_address) {
        msg +=
            "Please provide a validator destination address for the redelegation request.";
    } else {
        try {
            const { prefix } = bech32.decode(
                content.validator_dst_address as string
            );
            if (prefix !== "omniflixvaloper") {
                msg +=
                    "Please provide a valid Omniflix validator destination address for the redelegation request.";
            }
        } catch (error) {
            msg +=
                "Please provide a valid Omniflix validator destination address for the redelegation request.";
        }
    }
    if (!content.amount) {
        msg += "Please provide an amount for the redelegation request.";
    }
    if (!content.denom) {
        msg += "Please provide a denom for the redelegation request.";
    }
    if (msg !== "") {
        return {
            success: false,
            message: msg,
        };
    }
    return {
        success: true,
        message: "Redelegation request is valid.",
    };
}

const redelegateTokensTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "validator_src_address": "omniflixvaloper...",
    "validator_dst_address": "omniflixvaloper...",
    "amount": "100",
    "denom": "uflix"
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested token redelegation:
- validator_src_address mentioned in the current message
- validator_dst_address mentioned in the current message
- amount to redelegate mentioned in the current message
- denom(uflix/flix/FLIX) mentioned in the current message or recent messages (if any)

Respond with a JSON markdown block containing only the extracted values.`;

export class RedelegateTokensAction {
    async redelegate(
        params: RedelegateTokensContent,
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
            const stakingProvider = new StakingProvider(wallet);

            if (params.denom === "FLIX" || params.denom === "flix") {
                params.denom = "uflix";
                if (typeof params.amount === "number") {
                    params.amount = params.amount * 1000000;
                } else if (typeof params.amount === "string") {
                    params.amount = Number.parseInt(params.amount) * 1000000;
                }
            }

            const txHash = await stakingProvider.redelegate(
                params.validator_src_address,
                params.validator_dst_address,
                {
                    amount: params.amount.toString(),
                    denom: params.denom,
                }
            );

            return txHash.transactionHash;
        } catch (error) {
            throw new Error(`Transfer failed: ${error.message}`);
        }
    }
}

const buildRedelegateDetails = async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State
): Promise<RedelegateTokensContent> => {
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

    const redelegateContext = composeContext({
        state: currentState,
        template: redelegateTokensTemplate,
    });

    const content = await generateObjectDeprecated({
        runtime,
        context: redelegateContext,
        modelClass: ModelClass.SMALL,
    });

    const redelegateContent = content as RedelegateTokensContent;

    return redelegateContent;
};

export default {
    name: "TOKENS_REDELEGATE",
    similes: [
        "^redelegate\\b(?!.*undelegate)(?!.*delegate\\b)",
        "^redelegate_tokens\\b(?!.*undelegate)(?!.*delegate\\b)",
        "^redelegate_FLIX\\b(?!.*undelegate)(?!.*delegate\\b)",
        "^redelegate\\s+FLIX\\s+to(?!.*undelegate)(?!.*delegate\\b)",
    ],
    description: "Redelegate tokens to a specified omniflix validator address.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ) => {
        elizaLogger.log("Starting TOKENS_REDELEGATE handler...");

        const redelegateDetails = await buildRedelegateDetails(
            runtime,
            message,
            state
        );

        const validationResult = isRedelegateTokensContent(redelegateDetails);

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
            const action = new RedelegateTokensAction();
            const txHash = await action.redelegate(
                redelegateDetails,
                runtime,
                message,
                state
            );

            state = await runtime.updateRecentMessageState(state);

            if (callback) {
                if (redelegateDetails.denom === "uflix") {
                    redelegateDetails.amount =
                        (redelegateDetails.amount as number) / 1000000;
                }
                callback({
                    text: `Successfully delegated ${redelegateDetails.amount} FLIX from ${redelegateDetails.validator_src_address} to ${redelegateDetails.validator_dst_address}\nTxHash: ${txHash}`,
                    content: {
                        success: true,
                        hash: txHash,
                        amount: redelegateDetails.amount,
                        validator_src_address:
                            redelegateDetails.validator_src_address,
                        validator_dst_address:
                            redelegateDetails.validator_dst_address,
                    },
                });
            }
            return true;
        } catch (error) {
            if (callback) {
                callback({
                    text: `Error redelegating tokens: ${error.message}`,
                    content: { error: error.message },
                });
            }
            return false;
        }
    },
    template: redelegateTokensTemplate,
    validate: async (_runtime: IAgentRuntime) => {
        return true;
    },
    examples: redelegateExamples as ActionExample[][],
} as Action;
