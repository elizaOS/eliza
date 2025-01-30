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
import cancelUnbondingExamples from "../../action_examples/staking/cancel_unbonding.ts";

export interface CancelUnbondingContent extends Content {
    validator_address: string;
    creation_height: number;
    amount: string | number;
    denom: string;
    memo: string;
}

interface validationResult {
    success: boolean;
    message: string;
}

function isCancelUnbondingContent(content: Content): validationResult {
    let msg = "";
    if (!content.validator_address) {
        msg += "Missing validator address.";
    } else {
        try {
            const { prefix } = bech32.decode(
                content.validator_address as string
            );
            if (prefix !== "omniflixvaloper") {
                msg += "Invalid validator address.";
            }
        } catch (error) {
            msg += "Invalid validator address.";
        }
    }
    if (!content.amount) {
        msg += "Missing amount.";
    }
    if (!content.denom) {
        msg += "Missing denom.";
    }
    if (!content.creation_height) {
        msg += "Missing creation height of unbonding delegation.";
    }
    if (msg !== "") {
        return {
            success: false,
            message: msg,
        };
    }
    return {
        success: true,
        message: "Unbonding delegation request is valid.",
    };
}

const cancelUnbondingTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "validator_address": "omniflixvaloper...",
    "amount": "100",
    "denom": "uflix",
    "creation_height": 123456
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested unbonding delegation cancellation:
- validator_address mentioned in the current message
- amount to unbond mentioned in the current message
- denom mentioned in the current message or recent messages (if any)
- creation_height mentioned in the current message or recent messages (if any)

Respond with a JSON markdown block containing only the extracted values.`;

export class CancelUnbondingAction {
    async cancelUnbonding(
        params: CancelUnbondingContent,
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

            const txHash = await stakingProvider.cancelUnbondingDelegation(
                params.validator_address,
                params.creation_height,
                {
                    amount: params.amount.toString(),
                    denom: params.denom,
                }
            );

            return txHash.transactionHash;
        } catch (error) {
            throw new Error(
                `Unbonding delegation cancellation failed: ${error.message}`
            );
        }
    }
}

const buildCancelUnbondingContent = async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State
): Promise<CancelUnbondingContent> => {
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

    const cancelUnbondingContext = composeContext({
        state: currentState,
        template: cancelUnbondingTemplate,
    });

    const content = await generateObjectDeprecated({
        runtime,
        context: cancelUnbondingContext,
        modelClass: ModelClass.SMALL,
    });

    const cancelUnbondingContent = content as CancelUnbondingContent;

    return cancelUnbondingContent;
};

export default {
    name: "CANCEL_UNBONDING",
    similes: ["^cancel$", "^cancel_unbonding$", "^cancel unbonding"],
    description:
        "Cancel unbonding delegation to a specified omniflix validator address.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ) => {
        elizaLogger.log("Starting CANCEL_UNBONDING handler...");

        const cancelUnbondingContent = await buildCancelUnbondingContent(
            runtime,
            message,
            state
        );

        const validationResult = isCancelUnbondingContent(
            cancelUnbondingContent
        );
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
            const action = new CancelUnbondingAction();
            const txHash = await action.cancelUnbonding(
                cancelUnbondingContent,
                runtime,
                message,
                state
            );

            state = await runtime.updateRecentMessageState(state);

            if (callback) {
                if (cancelUnbondingContent.denom === "uflix") {
                    cancelUnbondingContent.amount =
                        (cancelUnbondingContent.amount as number) / 1000000;
                }
                callback({
                    text: `Successfully cancelled unbonding delegation of ${cancelUnbondingContent.amount} ${cancelUnbondingContent.denom} to ${cancelUnbondingContent.validator_address}\nTxHash: ${txHash}`,
                    content: {
                        success: true,
                        hash: txHash,
                        amount: cancelUnbondingContent.amount,
                        validator_address:
                            cancelUnbondingContent.validator_address,
                    },
                });
            }
            return true;
        } catch (error) {
            if (callback) {
                callback({
                    text: `Error occurred during TOKENS_UNBONDING please try again later with valid details.`,
                    content: { error: error.message },
                });
            }
            return false;
        }
    },
    template: cancelUnbondingTemplate,
    validate: async (_runtime: IAgentRuntime) => {
        return true;
    },
    examples: cancelUnbondingExamples as ActionExample[][],
} as Action;
