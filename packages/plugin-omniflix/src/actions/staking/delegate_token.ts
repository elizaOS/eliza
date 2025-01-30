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
import delegateTokensExamples from "../../action_examples/staking/delegate_token.ts";

export interface DelegateTokensContent extends Content {
    validator_address: string;
    amount: string | number;
    denom: string;
    memo: string;
}

interface validationResult {
    success: boolean;
    message: string;
}

function isDelegateTokensContent(content: Content): validationResult {
    let msg = "";
    if (!content.validator_address) {
        msg += "Please provide a validator address for the delegation request.";
    } else {
        try {
            const { prefix } = bech32.decode(
                content.validator_address as string
            );
            if (prefix !== "omniflixvaloper") {
                msg +=
                    "Please provide a valid Omniflix validator address for the delegation request.";
            }
        } catch (error) {
            msg +=
                "Please provide a valid Omniflix validator address for the delegation request.";
        }
    }
    if (!content.amount) {
        msg += "Please provide an amount for the delegation request.";
    }
    if (!content.denom) {
        msg += "Please provide a denom for the delegation request.";
    }
    if (msg !== "") {
        return {
            success: false,
            message: msg,
        };
    }
    return {
        success: true,
        message: "Delegation request is valid.",
    };
}

const delegateTokensTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "validator_address": "omniflixvaloper...",
    "amount": "100",
    "denom": "uflix"
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested token delegation:
- validator_address mentioned in the current message
- amount to delegate mentioned in the current message
- denom mentioned in the current message or recent messages (if any)

Respond with a JSON markdown block containing only the extracted values.`;

export class DelegateTokensAction {
    async delegate(
        params: DelegateTokensContent,
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

            const txHash = await stakingProvider.delegate(
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

const buildDelegateTokensContent = async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State
): Promise<DelegateTokensContent> => {

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

    const delegateContext = composeContext({
        state: currentState,
        template: delegateTokensTemplate,
    });

    const content = await generateObjectDeprecated({
        runtime,
        context: delegateContext,
        modelClass: ModelClass.SMALL,
    });

    const delegateContent = content as DelegateTokensContent;

    return delegateContent;
};

export default {
    name: "TOKENS_DELEGATE",
    similes: [
        "^delegate\\b(?!.*undelegate)(?!.*redelegate)",
        "^delegate_tokens\\b(?!.*undelegate)(?!.*redelegate)",
        "^delegate_FLIX\\b(?!.*undelegate)(?!.*redelegate)",
        "^delegate\\s+FLIX\\s+to(?!.*undelegate)(?!.*redelegate)",
    ],
    description: "Delegate tokens to a specified omniflix validator address.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ) => {
        elizaLogger.log("Starting TOKENS_DELEGATE handler...");

        const delegateContent = await buildDelegateTokensContent(
            runtime,
            message,
            state
        );

        const validationResult = isDelegateTokensContent(delegateContent);
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
            const action = new DelegateTokensAction();
            const txHash = await action.delegate(
                delegateContent,
                runtime,
                message,
                state
            );

            state = await runtime.updateRecentMessageState(state);

            if (callback) {
                if (delegateContent.denom === "uflix") {
                    delegateContent.amount =
                        (delegateContent.amount as number) / 1000000;
                }
                callback({
                    text: `Successfully delegated ${delegateContent.amount} FLIX to ${delegateContent.validator_address}\nTxHash: ${txHash}`,
                    content: {
                        success: true,
                        hash: txHash,
                        amount: delegateContent.amount,
                        validator_address: delegateContent.validator_address,
                    },
                });
            }
            return true;
        } catch (error) {
            if (callback) {
                callback({
                    text: `Error occurred during TOKENS_DELEGATE please try again later with valid details.`,
                    content: { error: error.message },
                });
            }
            return false;
        }
    },
    template: delegateTokensTemplate,
    validate: async (_runtime: IAgentRuntime) => {
        return true;
    },
    examples: delegateTokensExamples as ActionExample[][],
} as Action;
