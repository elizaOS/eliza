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
import { formatEther } from "viem";
import { FormWalletClient } from "../providers/wallet";
import { CurvesType } from "../utils/addresses";

interface SellCurvesParams {
    subject: string; // The subject address to sell curves for
    amount: number; // Number of curves tokens to sell
    formula: CurvesType; // The formula type (QUADRATIC or LOGARITHMIC)
}

export class SellCurvesTokenAction {
    constructor(private wallet: FormWalletClient) {}

    async sell(params: SellCurvesParams) {
        const formula = params.formula || "QUADRATIC";

        elizaLogger.debug(
            `[plugin-form][sell-curves-token] selling ${params.amount} curves tokens for subject ${params.subject} using ${formula} formula`
        );

        const curvesAddress = this.wallet.getCurvesAddress(formula);

        if (!curvesAddress) {
            throw new Error(
                `No curves contract found for formula ${formula} on chain ${this.wallet.getChain().id}`
            );
        }

        const subjectAddress = await this.wallet.resolveAddress(params.subject);

        // Get sell price first
        const sellPrice = await this.wallet.getCurvesSellPrice(
            curvesAddress,
            subjectAddress,
            params.amount
        );

        // Execute sell transaction
        const tx = await this.wallet.sellCurvesToken(
            curvesAddress,
            subjectAddress,
            params.amount
        );

        return {
            hash: tx.transactionHash,
            price: sellPrice,
            subject: subjectAddress,
            amount: params.amount,
            formula: formula,
            curvesAddress: curvesAddress,
        };
    }
}

const buildSellCurvesDetails = async (
    state: State,
    runtime: IAgentRuntime
): Promise<SellCurvesParams> => {
    const context = composeContext({
        state,
        template: sellCurvesTemplate,
    });

    const sellDetails = (await generateObjectDeprecated({
        runtime,
        context,
        modelClass: ModelClass.SMALL,
    })) as SellCurvesParams;

    if (!sellDetails.formula) {
        sellDetails.formula = "QUADRATIC";
    }

    return sellDetails;
};

export const sellCurvesTokenAction: Action = {
    name: "sell_curves_token",
    description:
        "Sell curves tokens for a subject address using specified formula",
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
            "[plugin-form][sell-curves-token] action handler called"
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
        const action = new SellCurvesTokenAction(wallet);

        try {
            const sellParams = await buildSellCurvesDetails(currentState, runtime);
            const sellResp = await action.sell(sellParams);

            if (callback) {
                callback({
                    text: `Successfully sold ${sellParams.amount} curves tokens for ${sellParams.subject} using ${sellResp.formula} formula\nTransaction Hash: ${sellResp.hash}\nSale price: ${formatEther(sellResp.price)} ETH`,
                    content: {
                        success: true,
                        hash: sellResp.hash,
                        amount: sellResp.amount,
                        subject: sellResp.subject,
                        price: formatEther(sellResp.price),
                        formula: sellResp.formula,
                        curvesAddress: sellResp.curvesAddress,
                    },
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error(
                "[plugin-form][sell-curves-token] error during curves token sale:",
                error
            );
            if (callback) {
                callback({
                    text: `Error selling curves tokens: ${error.message}`,
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
                    text: "I'll help you sell 2 curves token using QUADRATIC formula for 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
                    action: "SELL_CURVES",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "Sell 2 curves token for 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
                    action: "SELL_CURVES",
                },
            },
        ],
    ],
    similes: ["SELL_CURVES", "DISPOSE_CURVES", "EXIT_CURVES"],
};

const sellCurvesTemplate = `You are an AI assistant specialized in processing Form chain curves token sell requests. Your task is to extract specific information from user messages and format it into a structured JSON response.

First, review the recent messages from the conversation:
<recent_messages>
{{recentMessages}}
</recent_messages>

Your goal is to extract the following information about the curves token sale:
1. Subject address (must be a valid Ethereum address)
2. Amount of curve tokens to sell (default to 1 if not specified and must be an integer)
3. Formula type (must be be one of the available formulas or QUADRATIC if not specified)

Before providing the final JSON output, show your reasoning process inside <analysis> tags. Follow these steps:

1. Identify the relevant information:
 - Quote the part mentioning the subject address (the address whose curves you're selling).
 - Quote the part mentioning the amount (if any).
 - Quote the part mentioning the formula type (if any).

2. Validate each piece:
 Subject Address:
 - Must start with "0x"
 - Must be exactly 42 characters long
 - Verify it follows hexadecimal format (0-9, a-f)

 Amount:
 - Must be a positive integer number
 - If not specified, use 1 as default
 - Cannot be zero or negative
 - Must not exceed user's balance (if mentioned in conversation)

 Formula:
 - Must be one of the "Available Curves Formulas"
 - If not specified, use "QUADRATIC" as default
 - Verify case sensitivity matches exactly

3. Error Checking:
 - Flag any invalid address format
 - Flag any negative, zero, or non-integer amounts
 - Flag any unrecognized formula types
 - Flag if attempting to sell more than available balance (if balance is mentioned)

4. If all information is valid, summarize:
 - Confirmed subject address being sold
 - Final amount to sell (specified or default)
 - Selected formula (specified or default)

After your analysis, provide the final output in a JSON markdown block with this exact structure:
\`\`\`json
{
  "subject": string,    // The validated Ethereum address
  "amount": number,     // The number of curves tokens to sell
  "formula": string     // Either "QUADRATIC" or "LOGARITHMIC"
}
\`\`\`

Requirements:
- The subject field must be a valid Ethereum address starting with "0x" (42 characters)
- The amount field must be a positive integer (defaults to 1)
- The formula field must be exactly "QUADRATIC" or "LOGARITHMIC" (defaults to "QUADRATIC")

Example valid outputs:
\`\`\`json
{
  "subject": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
  "amount": 1,
  "formula": "QUADRATIC"
}
\`\`\`

\`\`\`json
{
  "subject": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
  "amount": 3,
  "formula": "LOGARITHMIC"
}
\`\`\`

{{providers}}

Now, process the user's sell request and provide your response.`;
