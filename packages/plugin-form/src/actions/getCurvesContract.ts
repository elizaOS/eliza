import {
    type Action,
    composeContext,
    elizaLogger,
    generateObjectDeprecated,
    type HandlerCallback,
    ModelClass,
    type IAgentRuntime,
    type Memory,
    type State,
} from "@elizaos/core";
import { FormWalletClient } from "../providers/wallet";
import { CurvesType } from "../utils/addresses";
import { Address } from "viem";

interface GetCurvesAddressParams {
    address: Address; // Curves contract address
    formula: CurvesType; // The forumula type
}

export class GetCurvesAddressAction {
    constructor(private wallet: FormWalletClient) {}

    async getAddress(params: GetCurvesAddressParams) {
        elizaLogger.debug(
            `[plugin-form][get-curves-address] resolving contract for formula ${params.formula}`
        );

        const curvesAddress = this.wallet.getCurvesAddress(params.formula);

        if (!curvesAddress) {
            throw new Error(
                `No curves contract found for formula ${params.formula} on chain ${this.wallet.getChain().id}`
            );
        }

        return {
            address: curvesAddress,
            formula: params.formula,
        };
    }
}

const buildGetCurvesAddressDetails = async (
    state: State,
    runtime: IAgentRuntime
): Promise<GetCurvesAddressParams> => {
    const context = composeContext({
        state,
        template: getCurvesFormulaTemplate,
    });

    return (await generateObjectDeprecated({
        runtime,
        context,
        modelClass: ModelClass.SMALL,
    })) as GetCurvesAddressParams;
};

export const getCurvesAddressAction: Action = {
    name: "get_curves_address",
    description: "Get the appropriate curves contract address",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ) => {
        // Initialize or update state
        let currentState = state;
        if (!currentState) {
            currentState = (await runtime.composeState(message)) as State;
        } else {
            currentState = await runtime.updateRecentMessageState(currentState);
        }

        elizaLogger.debug(
            "[plugin-form][get-curves-address] action handler called"
        );

        const isTestnet = runtime.getSetting("FORM_TESTNET") === "true";
        const privateKey = runtime.getSetting(
            "FORM_PRIVATE_KEY"
        ) as `0x${string}`;
        const wallet = new FormWalletClient(
            privateKey,
            runtime.cacheManager,
            isTestnet
        );
        const action = new GetCurvesAddressAction(wallet);

        try {
            const params = await buildGetCurvesAddressDetails(currentState, runtime);
            const result = await action.getAddress(params);

            if (callback) {
                callback({
                    text: `Resolved curves contract address ${result.address} for formula ${result.formula}`,
                    content: {
                        success: true,
                        curvesContractAddress: result.address,
                        curvesFormula: result.formula,
                    },
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error(
                "[plugin-form][get-curves-address] error resolving curves address:",
                error
            );
            if (callback) {
                callback({
                    text: `Error resolving curves contract: ${error.message}`,
                    content: { error: error.message },
                });
            }
            return false;
        }
    },
    validate: async (runtime: IAgentRuntime) => {
        const privateKey = runtime.getSetting("FORM_PRIVATE_KEY");
        return typeof privateKey === "string" && privateKey.startsWith("0x");
    },
    examples: [
        [
            {
                user: "{{agentName}}",
                content: {
                    text: "I'll help determine the appropriate curves contract for large curves bound groups",
                    action: "GET_CURVES_ADDRESS",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "What curves contract should I use for large curves bound groups?",
                    action: "GET_CURVES_ADDRESS",
                },
            },
        ],
    ],
    similes: [
        "RESOLVE_CURVES_CONTRACT",
        "GET_CURVES_CONTRACT",
        "FIND_CURVES_ADDRESS",
    ],
};

const getCurvesFormulaTemplate = `You are an AI assistant specialized in determining the appropriate Form chain curves formula type based on conversation context. Your task is to analyze the discussion and synthesize the formula involved.

First, review the recent messages from the conversation:
<recent_messages>
{{recentMessages}}
</recent_messages>

Your goal is to determine which formula type should be used based on the discussion context.

Before providing the final JSON output, show your reasoning process inside <analysis> tags. Follow these steps:

1. Context Analysis:
 - Is there any explicit mention of a formula type?
 - Are there keywords suggesting specific use cases? (e.g. "stable", "large groups", "small groups", "quadratic", "logarithmic")
 - What is the overall intent of the curves interaction?

2. Formula Selection Logic:
 If explicit formula mentioned from "Available Curves Formulas":
 - QUADRATIC: Standard bonding curve with quadratic price impact
 - LOGARITHMIC: Reduced price impact for high volume

 If no formula mentioned:
 - Default to QUADRATIC unless context strongly suggests otherwise
 - Look for terms indicating high volume or price stability needs

3. Validation:
 - Confirm the selected formula is one of the supported types
 - Verify the reasoning aligns with use case
 - Check if selection matches any stated requirements

4. Decision Summary:
 - State the selected formula
 - Provide brief reasoning for selection

After your analysis, provide the final output in a JSON markdown block:
\`\`\`json
{
  "formula": string    // Must be exactly one of "Available Curves Formulas"
}
\`\`\`

Remember:
- Default to "QUADRATIC" if context is unclear
- "LOGARITHMIC" is for high volume or stability-focused use cases
- Always exactly match case for formula names

Example responses:

For general use:
\`\`\`json
{
  "formula": "QUADRATIC"
}
\`\`\`

For high volume and large groups of curves holders:
\`\`\`json
{
  "formula": "LOGARITHMIC"
}
\`\`\`

{{providers}}

Now, analyze the discussion context and determine the appropriate formula.`;
