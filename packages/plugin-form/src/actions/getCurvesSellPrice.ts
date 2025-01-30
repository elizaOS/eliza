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

interface GetCurvesSellPriceParams {
    subject: string; // The subject's curves to check sell price for
    amount: number; // Number of curves tokens to simulate selling (defaults to 1)
    formula: CurvesType; // The formula type (QUADRATIC or LOGARITHMIC)
}

export class GetCurvesSellPriceAction {
    constructor(private wallet: FormWalletClient) {}

    async getPrice(params: GetCurvesSellPriceParams) {
        const formula = params.formula || "QUADRATIC";
        const amount = params.amount || 1;

        elizaLogger.debug(
            `[plugin-form][get-curves-sell-price] checking sell price for ${amount} curves of subject ${params.subject} using ${formula} formula`
        );

        const curvesAddress = this.wallet.getCurvesAddress(formula);
        if (!curvesAddress) {
            throw new Error(
                `No curves contract found for formula ${formula} on chain ${this.wallet.getChain().id}`
            );
        }

        const subjectAddress = await this.wallet.resolveAddress(params.subject);

        // Check current balance first
        const balance = await this.wallet.getCurvesTokenBalance(
            curvesAddress,
            this.wallet.getAddress(),
            subjectAddress
        );

        if (balance < BigInt(amount)) {
            throw new Error(
                `Insufficient balance to sell ${amount} curves tokens. Current balance: ${formatEther(balance)}`
            );
        }

        // Get sell price quote
        const price = await this.wallet.getCurvesSellPrice(
            curvesAddress,
            subjectAddress,
            amount
        );

        return {
            subject: subjectAddress,
            amount: amount,
            price: price,
            currentBalance: balance,
            formula: formula,
            curvesAddress: curvesAddress,
        };
    }
}

export const getCurvesSellPriceAction: Action = {
    name: "get_curves_sell_price",
    description: "Check sell price for Curves tokens",
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
            "[plugin-form][get-curves-sell-price] action handler called"
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
        const action = new GetCurvesSellPriceAction(wallet);

        try {
            const params = (await generateObjectDeprecated({
                runtime,
                context: composeContext({
                    state: currentState,
                    template: getCurvesSellPriceTemplate,
                }),
                modelClass: ModelClass.SMALL,
            })) as GetCurvesSellPriceParams;

            params.formula = params.formula ?? "QUADRATIC";
            params.amount = params.amount ?? 1;

            const priceResp = await action.getPrice(params);

            if (callback) {
                callback({
                    text: `Sell Price Quote:
Subject: ${priceResp.subject}
Amount: ${priceResp.amount} curves
Price: ${formatEther(priceResp.price)} ETH
Current Balance: ${formatEther(priceResp.currentBalance)} curves
Formula: ${priceResp.formula}`,
                    content: {
                        success: true,
                        subject: priceResp.subject,
                        amount: priceResp.amount,
                        price: priceResp.price.toString(),
                        priceFormatted: formatEther(priceResp.price),
                        currentBalance: priceResp.currentBalance.toString(),
                        formula: priceResp.formula,
                        curvesAddress: priceResp.curvesAddress,
                    },
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error(
                "[plugin-form][get-curves-sell-price] error getting price:",
                error
            );
            if (callback) {
                callback({
                    text: `Error getting curves sell price: ${error.message}`,
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
                    text: "I'll help you check the sell price for 1 curves token of 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
                    action: "GET_CURVES_SELL_PRICE",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "How much can I get for selling curves of 0x742d35Cc6634C0532925a3b844Bc454e4438f44e?",
                    action: "GET_CURVES_SELL_PRICE",
                },
            },
        ],
    ],
    similes: [
        "GET_CURVES_SELL_PRICE",
        "CHECK_SELL_PRICE",
        "QUOTE_CURVES_SELL",
        "SIMULATE_CURVES_SELL",
        "EXIT_PRICE_CHECK",
    ],
};

const getCurvesSellPriceTemplate = `You are an AI assistant specialized in checking Form chain curves token sell prices. Your task is to extract the price check parameters from the conversation context.

First, review the recent messages from the conversation:
<recent_messages>
{{recentMessages}}
</recent_messages>

Your goal is to extract:
1. Subject address (whose curves to get sell price for)
2. Amount to simulate selling (defaults to 1 if not specified)
3. Determine the formula type based on context

Before providing the final JSON output, show your reasoning process inside <analysis> tags. Follow these steps:

1. Identify and Quote Information:
 - Quote mentions of the subject address
 - Quote mentions of the amount to sell
 - Quote any references to formula type or market patterns
 - Note any mentioned current balance or holdings

2. Address Validation:
 - Must start with "0x"
 - Must be exactly 42 characters long
 - Must follow hexadecimal format (0-9, a-f)

3. Amount Validation:
 - Must be a positive number
 - If not specified, use 1 as default
 - Cannot be zero
 - Can be a decimal (e.g., 0.5, 2.5)
 - Should not exceed mentioned balance (if any)

4. Formula Determination:
 If formula is explicitly mentioned:
 - QUADRATIC: Standard bonding curve
 - LOGARITHMIC: For high volume or stability focus

 If no formula mentioned, analyze:
 - Look for keywords suggesting high volume/stability needs
 - Consider mentioned market patterns
 - Look for exit strategy mentions
 - Default to QUADRATIC if context is unclear

5. Context Analysis:
 - Is this for portfolio exit?
 - Is this a price check before selling?
 - Are we comparing different sell amounts?
 - Any urgency in selling?

6. Final Summary:
 - Confirmed subject address
 - Validated sell amount
 - Selected formula with reasoning
 - Note any balance constraints

After your analysis, provide the final output in a JSON markdown block:
\`\`\`json
{
  "subject": string,    // Validated Ethereum address
  "amount": number,     // Positive number of tokens to simulate selling
  "formula": string     // Either "QUADRATIC" or "LOGARITHMIC"
}
\`\`\`

Requirements:
- Subject: valid Ethereum address (0x... format, 42 chars)
- Amount: positive number (defaults to 1)
- Formula: exactly "QUADRATIC" or "LOGARITHMIC" (defaults to "QUADRATIC")

Example valid outputs:

Checking sell price for 1 token:
\`\`\`json
{
  "subject": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
  "amount": 1,
  "formula": "QUADRATIC"
}
\`\`\`

Checking gradual exit price:
\`\`\`json
{
  "subject": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
  "amount": 0.5,
  "formula": "LOGARITHMIC"
}
\`\`\`

{{providers}}

Now, analyze the sell price check request and provide your response.`;
