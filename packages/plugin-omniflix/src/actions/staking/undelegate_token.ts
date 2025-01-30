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
import undelegateExamples from "../../action_examples/staking/undelegate_token.ts";

export interface UndelegateTokensContent extends Content {
    validator_address: string;
    amount: string | number;
    denom: string;
    memo: string;
}

interface validationResult {
    success: boolean;
    message: string;
}

function isUndelegateTokensContent(content: Content): validationResult {
    let msg = "";
    if (!content.validator_address) {
        msg +=
            "Please provide a validator address for the undelegation request.";
    } else {
        try {
            const { prefix } = bech32.decode(
                content.validator_address as string
            );
            if (prefix !== "omniflixvaloper") {
                msg +=
                    "Please provide a valid Omniflix validator address for the undelegation request.";
            }
        } catch {
            msg +=
                "Please provide a valid Omniflix validator address for the undelegation request.";
        }
    }
    if (!content.amount) {
        msg += "Please provide an amount for the undelegation request.";
    }
    if (!content.denom) {
        msg += "Please provide a denom for the undelegation request.";
    }
    if (msg !== "") {
        return {
            success: false,
            message: msg,
        };
    }
    return {
        success: true,
        message: "Undelegation request is valid.",
    };
}

const undelegateTokensTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "validator_address": "omniflixvaloper...",
    "amount": "100",
    "denom": "FLIX"
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested token undelegation:
- validator_address mentioned in the current message
- amount to undelegate mentioned in the current message
- denom(uflix/flix/FLIX) mentioned in the current message or recent messages (if any)

Respond with a JSON markdown block containing only the extracted values.`;

export class UndelegateTokensAction {
    async undelegate(
        params: UndelegateTokensContent,
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

            const txHash = await stakingProvider.undelegate(
                params.validator_address,
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

const buildUndelegateTokensContent = async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State
): Promise<UndelegateTokensContent> => {
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

    const undelegateContext = composeContext({
        state: currentState,
        template: undelegateTokensTemplate,
    });

    const content = await generateObjectDeprecated({
        runtime,
        context: undelegateContext,
        modelClass: ModelClass.SMALL,
    });

    const undelegateContent = content as UndelegateTokensContent;

    return undelegateContent;
};

export default {
    name: "TOKENS_UNDELEGATE",
    similes: [
        "^undelegate\\b",
        "^undelegate_tokens\\b",
        "^undelegate_FLIX\\b",
        "^undelegate\\s+FLIX\\s+from",
        "^remove_delegation",
        "^withdraw_delegation",
    ],
    description:
        "Undelegate tokens from a specified omniflix validator address.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ) => {
        elizaLogger.log("Starting TOKENS_UNDELEGATE handler...");

        const undelegateContent = await buildUndelegateTokensContent(
            runtime,
            message,
            state
        );

        const validationResult = isUndelegateTokensContent(undelegateContent);

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
            const action = new UndelegateTokensAction();
            const txHash = await action.undelegate(
                undelegateContent,
                runtime,
                message,
                state
            );

            state.memo = undelegateContent.memo;

            state = await runtime.updateRecentMessageState(state);

            if (callback) {
                if (undelegateContent.denom === "uflix") {
                    undelegateContent.amount =
                        (undelegateContent.amount as number) / 1000000;
                }
                callback({
                    text: `Successfully undelegated ${undelegateContent.amount} FLIX from ${undelegateContent.validator_address}\nTxHash: ${txHash}`,
                    content: {
                        success: true,
                        hash: txHash,
                        amount: undelegateContent.amount,
                        validator_address: undelegateContent.validator_address,
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
    template: undelegateTokensTemplate,
    validate: async (_runtime: IAgentRuntime) => {
        return true;
    },
    examples: undelegateExamples as ActionExample[][],
} as Action;
