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
import { formatUnits, parseUnits } from "viem";
import { FormWalletClient } from "../providers/wallet";
import { CurvesType } from "../utils/addresses";

interface DepositCurvesParams {
    subject: string; // The subject address whose ERC20 to deposit
    amount: number; // Number of curves tokens to receive (must be in lowest ERC20 denomination: 18 decimals)
    formula: CurvesType; // The formula type (QUADRATIC or LOGARITHMIC)
}

export class DepositCurvesTokenAction {
    constructor(private wallet: FormWalletClient) {}

    async deposit(params: DepositCurvesParams) {
        const formula = params.formula || "QUADRATIC";

        elizaLogger.debug(
            `[plugin-form][deposit-curves-token] depositing ERC20 equivalent of ${params.amount} curves tokens for subject ${params.subject} using ${formula} formula`
        );

        const curvesAddress = this.wallet.getCurvesAddress(formula);
        if (!curvesAddress) {
            throw new Error(
                `No curves contract found for formula ${formula} on chain ${this.wallet.getChain().id}`
            );
        }

        const subjectAddress = await this.wallet.resolveAddress(params.subject);

        // Convert amount to proper decimal precision
        const depositAmount = parseUnits(params.amount.toString(), 18);

        // Execute deposit transaction
        const tx = await this.wallet.depositCurves(
            curvesAddress,
            subjectAddress,
            depositAmount
        );

        // Get ERC20 token info first
        const erc20Info = await this.wallet.getCurvesERC20TokenDetails(
            curvesAddress,
            subjectAddress
        );

        return {
            hash: tx.transactionHash,
            subject: subjectAddress,
            amount: params.amount,
            depositAmount: depositAmount,
            formula: formula,
            curvesAddress: curvesAddress,
            erc20Token: erc20Info,
        };
    }
}

export const depositCurvesTokenAction: Action = {
    name: "deposit_curves_token",
    description: "Convert ERC20 tokens to their Curves equivalent",
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
            "[plugin-form][deposit-curves-token] action handler called"
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
        const action = new DepositCurvesTokenAction(wallet);

        try {
            const depositParams = (await generateObjectDeprecated({
                runtime,
                context: composeContext({
                    state: currentState,
                    template: depositCurvesTemplate,
                }),
                modelClass: ModelClass.SMALL,
            })) as DepositCurvesParams;

            depositParams.formula = depositParams.formula ?? "QUADRATIC";

            const depositResp = await action.deposit(depositParams);

            if (callback) {
                callback({
                    text: `Successfully deposited ${formatUnits(depositResp.depositAmount, 18)} ${depositResp.erc20Token.symbol} to receive ${depositParams.amount} curves tokens\nTransaction Hash: ${depositResp.hash}`,
                    content: {
                        success: true,
                        hash: depositResp.hash,
                        amount: depositResp.amount,
                        depositAmount: depositResp.depositAmount.toString(),
                        subject: depositResp.subject,
                        formula: depositResp.formula,
                        curvesAddress: depositResp.curvesAddress,
                        erc20Token: depositResp.erc20Token,
                    },
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error(
                "[plugin-form][deposit-curves-token] error during deposit:",
                error
            );
            if (callback) {
                callback({
                    text: `Error depositing ERC20 tokens: ${error.message}`,
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
                    text: "I'll help you deposit ERC20 tokens to get 1 curves token for 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
                    action: "DEPOSIT_CURVES",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "Convert my ERC20 tokens for 0x742d35Cc6634C0532925a3b844Bc454e4438f44e to Curves",
                    action: "DEPOSIT_CURVES",
                },
            },
        ],
    ],
    similes: [
        "DEPOSIT_CURVES",
        "CONVERT_ERC20_TO_CURVES",
        "GET_CURVES_FROM_ERC20",
    ],
};

const depositCurvesTemplate = `You are an AI assistant specialized in processing Form chain ERC20 token deposits to Curves. Your task is to extract information and determine the appropriate formula from the conversation context.

First, review the recent messages from the conversation:
<recent_messages>
{{recentMessages}}
</recent_messages>

Your goal is to extract:
1. Subject address (whose ERC20 tokens you're converting to Curves)
2. Amount of Curves tokens to receive (will be automatically converted to 18 decimals)
3. Determine the formula type based on context

Before providing the final JSON output, show your reasoning process inside <analysis> tags. Follow these steps:

1. Identify and Quote Information:
 - Quote mentions of the subject address
 - Quote mentions of deposit amount
 - Quote any references to formula type or trading patterns

2. Subject Address Validation:
 - Must start with "0x"
 - Must be exactly 42 characters long
 - Must follow hexadecimal format (0-9, a-f)

3. Amount Validation:
 - Must be a positive number
 - Default to 1 if not specified
 - Cannot be zero
 - Convert cleanly to 18 decimal precision
 - Must not exceed available ERC20 balance (if mentioned)

4. Formula Determination:
 If formula is explicitly mentioned:
 - QUADRATIC: Standard bonding curve
 - LOGARITHMIC: For high volume or stability focus

 If no formula mentioned, analyze:
 - Look for keywords suggesting high volume/stability needs
 - Consider mentioned use cases or patterns
 - Default to QUADRATIC if context is unclear

5. Error Checking:
 - Invalid address format
 - Invalid amounts
 - Unsupported formula types
 - Balance exceeded (if known)

6. Final Summary:
 - Verified subject address
 - Confirmed deposit amount (in standard units)
 - Selected formula with reasoning

After your analysis, provide the final output in a JSON markdown block:
\`\`\`json
{
  "subject": string,    // Validated Ethereum address
  "amount": number,     // Amount in standard units (will be converted to 18 decimals)
  "formula": string     // Either "QUADRATIC" or "LOGARITHMIC"
}
\`\`\`

Requirements:
- Subject: valid Ethereum address (0x... format, 42 chars)
- Amount: positive number (defaults to 1)
- Formula: exactly "QUADRATIC" or "LOGARITHMIC" (defaults to "QUADRATIC")

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
  "amount": 2.5,
  "formula": "LOGARITHMIC"
}
\`\`\`

{{providers}}

Now, analyze the deposit request and provide your response.`;
