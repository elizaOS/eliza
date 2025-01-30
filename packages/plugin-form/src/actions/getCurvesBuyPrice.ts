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

interface GetCurvesBuyPriceParams {
    subject: string; // The subject's curves to check price for
    amount: number; // Number of curves tokens to simulate buying (defaults to 1)
    formula: CurvesType; // The formula type (QUADRATIC or LOGARITHMIC)
}

export class GetCurvesBuyPriceAction {
    constructor(private wallet: FormWalletClient) {}

    async getPrice(params: GetCurvesBuyPriceParams) {
        const formula = params.formula || "QUADRATIC";
        const amount = params.amount || 1;

        elizaLogger.debug(
            `[plugin-form][get-curves-price] checking buy price for ${amount} curves of subject ${params.subject} using ${formula} formula`
        );

        const curvesAddress = this.wallet.getCurvesAddress(formula);
        if (!curvesAddress) {
            throw new Error(
                `No curves contract found for formula ${formula} on chain ${this.wallet.getChain().id}`
            );
        }

        const subjectAddress = await this.wallet.resolveAddress(params.subject);

        // Get price quote
        const price = await this.wallet.getCurvesBuyPrice(
            curvesAddress,
            subjectAddress,
            amount
        );

        return {
            subject: subjectAddress,
            amount: amount,
            price: price,
            formula: formula,
            curvesAddress: curvesAddress,
        };
    }
}

export const getCurvesBuyPriceAction: Action = {
    name: "get_curves_buy_price",
    description: "Check buy price for Curves tokens",
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
            "[plugin-form][get-curves-price] action handler called"
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
        const action = new GetCurvesBuyPriceAction(wallet);

        try {
            const params = (await generateObjectDeprecated({
                runtime,
                context: composeContext({
                    state: currentState,
                    template: getCurvesBuyPriceTemplate,
                }),
                modelClass: ModelClass.SMALL,
            })) as GetCurvesBuyPriceParams;

            params.formula = params.formula ?? "QUADRATIC";
            params.amount = params.amount ?? 1;

            const priceResp = await action.getPrice(params);

            if (callback) {
                callback({
                    text: `Buy Price Quote:
 Subject: ${priceResp.subject}
 Amount: ${priceResp.amount} curves
 Price: ${formatEther(priceResp.price)} ETH
 Formula: ${priceResp.formula}`,
                    content: {
                        success: true,
                        subject: priceResp.subject,
                        amount: priceResp.amount,
                        price: priceResp.price.toString(),
                        priceFormatted: formatEther(priceResp.price),
                        formula: priceResp.formula,
                        curvesAddress: priceResp.curvesAddress,
                    },
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error(
                "[plugin-form][get-curves-price] error getting price:",
                error
            );
            if (callback) {
                callback({
                    text: `Error getting curves buy price: ${error.message}`,
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
                    text: "I'll help you check the price for buying 1 curves token of 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
                    action: "GET_CURVES_PRICE",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "How much to buy curves for 0x742d35Cc6634C0532925a3b844Bc454e4438f44e?",
                    action: "GET_CURVES_PRICE",
                },
            },
        ],
    ],
    similes: [
        "GET_CURVES_PRICE",
        "CHECK_BUY_PRICE",
        "QUOTE_CURVES_PRICE",
        "SIMULATE_CURVES_BUY",
    ],
};

const getCurvesBuyPriceTemplate = `You are an AI assistant specialized in checking Form chain curves token buy prices. Your task is to extract the price check parameters from the conversation context.

 First, review the recent messages from the conversation:
 <recent_messages>
 {{recentMessages}}
 </recent_messages>

 Your goal is to extract:
 1. Subject address (whose curves to check price for)
 2. Amount to simulate buying (defaults to 1 if not specified)
 3. Determine the formula type based on context

 Before providing the final JSON output, show your reasoning process inside <analysis> tags. Follow these steps:

 1. Identify and Quote Information:
 - Quote mentions of the subject address
 - Quote mentions of the amount to buy
 - Quote any references to formula type or market patterns

 2. Address Validation:
 - Must start with "0x"
 - Must be exactly 42 characters long
 - Must follow hexadecimal format (0-9, a-f)

 3. Amount Validation:
 - Must be a positive number
 - If not specified, use 1 as default
 - Cannot be zero
 - Can be a decimal (e.g., 0.5, 2.5)

 4. Formula Determination:
 If formula is explicitly mentioned:
 - QUADRATIC: Standard bonding curve
 - LOGARITHMIC: For high volume or stability focus

 If no formula mentioned, analyze:
 - Look for keywords suggesting high volume/stability needs
 - Consider mentioned market patterns
 - Default to QUADRATIC if context is unclear

 5. Context Analysis:
 - Is this for market making?
 - Is this a price check before buying?
 - Are we comparing different amounts?

 6. Final Summary:
 - Confirmed subject address
 - Validated amount to simulate
 - Selected formula with reasoning

 After your analysis, provide the final output in a JSON markdown block:
 \`\`\`json
 {
  "subject": string,    // Validated Ethereum address
  "amount": number,     // Positive number of tokens to simulate buying
  "formula": string     // Either "QUADRATIC" or "LOGARITHMIC"
 }
 \`\`\`

 Requirements:
 - Subject: valid Ethereum address (0x... format, 42 chars)
 - Amount: positive number (defaults to 1)
 - Formula: exactly "QUADRATIC" or "LOGARITHMIC" (defaults to "QUADRATIC")

 Example valid outputs:

 Checking price for 1 token:
 \`\`\`json
 {
  "subject": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
  "amount": 1,
  "formula": "QUADRATIC"
 }
 \`\`\`

 Checking price for multiple tokens:
 \`\`\`json
 {
  "subject": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
  "amount": 2.5,
  "formula": "LOGARITHMIC"
 }
 \`\`\`

 {{providers}}

 Now, analyze the price check request and provide your response.`;
