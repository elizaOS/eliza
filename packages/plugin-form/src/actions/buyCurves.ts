import {
    Action,
    composeContext,
    elizaLogger,
    generateObjectDeprecated,
    HandlerCallback,
    ModelClass,
    type IAgentRuntime,
    type Memory,
    type State,
} from "@elizaos/core";
import { formatEther } from "viem";
import { FormWalletClient } from "../providers/wallet";
import { CurvesType } from "../utils/addresses";

// Updated parameters interface to match curves formulas
interface BuyCurvesParams {
    subject: string; // The subject address to buy curves for
    amount: number; // Number of curves tokens to buy
    formula: CurvesType; // The formula type (QUADRATIC or LOGARITHMIC)
}

export class BuyCurvesTokenAction {
    constructor(private wallet: FormWalletClient) {}

    async buy(params: BuyCurvesParams) {
        // Default to QUADRATIC if no formula specified
        const formula = params.formula || "QUADRATIC";

        elizaLogger.debug(
            `[plugin-form][buy-curves-token] buying ${params.amount} curves tokens for subject ${params.subject} using ${formula} formula`
        );

        // Get the curves contract address based on chain and formula
        const curvesAddress = this.wallet.getCurvesAddress(formula);

        if (!curvesAddress) {
            throw new Error(
                `No curves contract found for formula ${formula} on chain ${this.wallet.getChain().id}`
            );
        }

        const subjectAddress = await this.wallet.resolveAddress(params.subject);

        // Get buy price first
        const buyPrice = await this.wallet.getCurvesBuyPrice(
            curvesAddress,
            subjectAddress,
            params.amount
        );

        // Execute buy transaction
        const tx = await this.wallet.buyCurvesToken(
            curvesAddress,
            subjectAddress,
            params.amount
        );

        return {
            hash: tx.transactionHash,
            price: buyPrice,
            subject: subjectAddress,
            amount: params.amount,
            formula: formula,
            curvesAddress: curvesAddress,
        };
    }
}

const buildBuyCurvesDetails = async (
    state: State,
    runtime: IAgentRuntime
): Promise<BuyCurvesParams> => {
    const context = composeContext({
        state,
        template: buyCurvesTemplate,
    });

    const buyDetails = (await generateObjectDeprecated({
        runtime,
        context,
        modelClass: ModelClass.SMALL,
    })) as BuyCurvesParams;

    // Default to QUADRATIC if no formula specified
    if (!buyDetails.formula) {
        buyDetails.formula = "QUADRATIC";
    }

    return buyDetails;
};

export const buyCurvesTokenAction: Action = {
    name: "buy_curves_token",
    description:
        "Buy curves tokens for a subject address using specified formula",
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
            "[plugin-form][buy-curves-token] action handler called"
        );

        // Initialize Form wallet client
        const isTestnet = runtime.getSetting("FORM_TESTNET") === "true";
        const privateKey = runtime.getSetting(
            "FORM_PRIVATE_KEY"
        ) as `0x${string}`;
        const wallet = new FormWalletClient(
            privateKey,
            runtime.cacheManager,
            isTestnet
        );
        const action = new BuyCurvesTokenAction(wallet);

        try {
            // Build buy parameters from conversation
            const buyParams = await buildBuyCurvesDetails(currentState, runtime);

            // Execute buy transaction
            const buyResp = await action.buy(buyParams);

            if (callback) {
                callback({
                    text: `Successfully bought ${buyParams.amount} curves tokens for ${buyParams.subject} using ${buyResp.formula} formula\nTransaction Hash: ${buyResp.hash}\nPrice paid: ${formatEther(buyResp.price)} ETH`,
                    content: {
                        success: true,
                        hash: buyResp.hash,
                        amount: buyResp.amount,
                        subject: buyResp.subject,
                        price: formatEther(buyResp.price),
                        formula: buyResp.formula,
                        curvesAddress: buyResp.curvesAddress,
                    },
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error(
                "[plugin-form][buy-curves-token] error during curves token purchase:",
                error
            );
            if (callback) {
                callback({
                    text: `Error buying curves tokens: ${error.message}`,
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
                    text: "I'll help you buy 1 curves token using QUADRATIC formula for 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
                    action: "BUY_CURVES",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "Buy a curves token for 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
                    action: "BUY_CURVES",
                },
            },
        ],
    ],
    similes: ["BUY_CURVES", "PURCHASE_CURVES", "GET_CURVES"],
};

const buyCurvesTemplate = `You are an AI assistant specialized in processing Form chain curves token purchase requests. Your task is to extract specific information from user messages and format it into a structured JSON response.

First, review the recent messages from the conversation:
<recent_messages>
{{recentMessages}}
</recent_messages>

Your goal is to extract the following information about the curves token purchase:
1. Subject address (must be a valid Ethereum address)
2. Amount of curve tokens to buy (default to 1 if not specified and must be an integer)
3. Formula type (must be be one of the available formulas or QUADRATIC if not specified)

Before providing the final JSON output, show your reasoning process inside <analysis> tags. Follow these steps:

1. Identify the relevant information:
 - Quote the part mentioning the subject address.
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
 - Cannot be zero

 Formula:
 - Must be one of the "Available Curves Formulas"
 - If not specified, use "QUADRATIC" as default
 - Verify case sensitivity matches exactly

3. Error Checking:
 - Flag any invalid address format
 - Flag any negative or zero amounts
 - Flag any unrecognized formula types

4. If all information is valid, summarize:
 - Confirmed subject address
 - Final amount (specified or default)
 - Selected formula (specified or default)

After your analysis, provide the final output in a JSON markdown block with this exact structure:
\`\`\`json
{
  "subject": string,    // The validated Ethereum address
  "amount": number,     // The number of curves tokens to buy
  "formula": string     // Either "QUADRATIC" or "LOGARITHMIC"
}
\`\`\`

Requirements:
- The subject field must be a valid Ethereum address starting with "0x" (42 characters)
- The amount field must be a positive number (defaults to 1)
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
  "amount": 5,
  "formula": "LOGARITHMIC"
}
\`\`\`

{{providers}}

Now, process the user's request and provide your response.`;
