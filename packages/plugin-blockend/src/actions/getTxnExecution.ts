import {
    Action,
    IAgentRuntime,
    HandlerCallback,
    Memory,
    State,
    composeContext,
    ModelClass,
    generateObjectDeprecated,
    elizaLogger,
} from "@elizaos/core";
import { validateBlockendConfig } from "../environment";
import { getTxnExecutionExamples } from "../examples";
import { createBlockendService } from "../services";
const template = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.
Example response:
\`\`\`json
{
    "fromAssetSymbol": "SOL",
    "toAssetSymbol": "USDC",
    "fromChainName": "solana",
    "toChainName": "ethereum",
    "amount": 1.5,
    "slippage": 50
}
\`\`\`

{{recentMessages}}

Given the recent messages and wallet information below:

{{walletInfo}}

Extract the following information about the requested token execution:
- fromAssetSymbol (the token being sold)
- toAssetSymbol (the token being bought)
- fromChainName (the chain the token is being sold from)
- toChainName (the chain the token is being bought to)
- amount (the amount of the token to be swapped)

Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined. The result should be a valid JSON object with the following schema:
\`\`\`json
{
    "fromAssetSymbol": string | null,
    "toAssetSymbol": string | null,
    "fromChainName": string | null,
    "toChainName": string | null,
    "amount": number | string | null,
    "slippage": number | string | null
}
\`\`\``;
export const getTxnExecution: Action = {
    name: "GET_TXN_EXECUTION",
    similes: ["swap", "bridge", "transfer"],
    description: "Get the execution of a transaction",
    validate: async (runtime: IAgentRuntime) => {
        const config = await validateBlockendConfig(runtime);
        return true;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: any,
        callback: HandlerCallback
    ) => {
        elizaLogger.log("Getting txn execution from blockend");
        const config = await validateBlockendConfig(runtime);
        // composeState
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }
        const swapContext = composeContext({
            state,
            template: template,
        });
        const response = await generateObjectDeprecated({
            runtime,
            context: swapContext,
            modelClass: ModelClass.LARGE,
        });
        elizaLogger.log("Response", response);
        const blockendService = createBlockendService(
            config.BLOCKEND_INTEGRATOR_ID
        );
        if (!response.fromChainName || !response.toChainName) {
            elizaLogger.log("Invalid response", response);
            callback?.({ text: "from and to chain name is required" });
            return true;
        }
        if (!response.fromAssetSymbol || !response.toAssetSymbol) {
            elizaLogger.log("Invalid response", response);
            callback?.({ text: "from and to asset symbol is required" });
            return true;
        }
        if (!response.amount) {
            elizaLogger.log("Invalid response", response);
            callback?.({ text: "amount is required" });
            return true;
        }
        try {
            const txnExecution = await blockendService.executeTransaction(
                response,
                config
            );
            elizaLogger.log("Txn Execution", txnExecution);
            callback?.(txnExecution);
            return true;
        } catch (error) {
            elizaLogger.error("Error", error.message || error.details);
            callback?.({ text: "error" });
            return false;
        }
    },
    examples: getTxnExecutionExamples,
};
