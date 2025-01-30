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

interface WithdrawCurvesParams {
    subject: string; // The subject address whose curves to withdraw
    amount: number; // Number of curves tokens to withdraw to ERC20
    formula: CurvesType; // The formula type (QUADRATIC or LOGARITHMIC)
}

export class WithdrawCurvesTokenAction {
    constructor(private wallet: FormWalletClient) {}

    async withdraw(params: WithdrawCurvesParams) {
        const formula = params.formula || "QUADRATIC";

        elizaLogger.debug(
            `[plugin-form][withdraw-curves-token] withdrawing ${params.amount} curves tokens for subject ${params.subject} using ${formula} formula`
        );

        const curvesAddress = this.wallet.getCurvesAddress(formula);

        if (!curvesAddress) {
            throw new Error(
                `No curves contract found for formula ${formula} on chain ${this.wallet.getChain().id}`
            );
        }

        const subjectAddress = await this.wallet.resolveAddress(params.subject);

        // Execute withdrawal transaction
        const tx = await this.wallet.withdrawCurves(
            curvesAddress,
            subjectAddress,
            params.amount
        );

        // Get ERC20 token info after withdrawal
        const erc20Info = await this.wallet.getCurvesERC20TokenDetails(
            curvesAddress,
            subjectAddress
        );

        return {
            hash: tx.transactionHash,
            subject: subjectAddress,
            amount: params.amount,
            formula: formula,
            curvesAddress: curvesAddress,
            erc20Token: erc20Info,
        };
    }
}

export const withdrawCurvesTokenAction: Action = {
    name: "withdraw_curves_token",
    description: "Convert Curves tokens to their ERC20 equivalent token",
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
            "[plugin-form][withdraw-curves-token] action handler called"
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
        const action = new WithdrawCurvesTokenAction(wallet);

        try {
            // First determine the formula being used
            const withdrawParams = (await generateObjectDeprecated({
                runtime,
                context: composeContext({
                    state: currentState,
                    template: withdrawCurvesTemplate,
                }),
                modelClass: ModelClass.SMALL,
            })) as WithdrawCurvesParams;

            withdrawParams.formula = withdrawParams.formula ?? "QUADRATIC";

            const withdrawResp = await action.withdraw(withdrawParams);

            if (callback) {
                callback({
                    text: `Successfully withdrew ${withdrawParams.amount} curves tokens to ERC20 ${withdrawResp.erc20Token.symbol}\nTransaction Hash: ${withdrawResp.hash}\nERC20 Token Address: ${withdrawResp.erc20Token.address}`,
                    content: {
                        success: true,
                        hash: withdrawResp.hash,
                        amount: withdrawResp.amount,
                        subject: withdrawResp.subject,
                        formula: withdrawResp.formula,
                        curvesAddress: withdrawResp.curvesAddress,
                        erc20Token: withdrawResp.erc20Token,
                    },
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error(
                "[plugin-form][withdraw-curves-token] error during withdrawal:",
                error
            );
            if (callback) {
                callback({
                    text: `Error withdrawing curves tokens: ${error.message}`,
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
                    text: "I'll help you withdraw 1 curves token to ERC20 for 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
                    action: "WITHDRAW_CURVES",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "Convert my curves token for 0x742d35Cc6634C0532925a3b844Bc454e4438f44e to ERC20",
                    action: "WITHDRAW_CURVES",
                },
            },
        ],
    ],
    similes: [
        "WITHDRAW_CURVES",
        "CONVERT_CURVES_TO_ERC20",
        "GET_ERC20_FROM_CURVES",
    ],
};

const withdrawCurvesTemplate = `You are an AI assistant specialized in processing Form chain curves token withdrawals to ERC20. Your task is to extract information and determine the appropriate formula from the conversation context.

First, review the recent messages from the conversation:
<recent_messages>
{{recentMessages}}
</recent_messages>

Your goal is to extract:
1. Subject address (whose curves you're converting to ERC20)
2. Amount of curves tokens to withdraw (must be an integer and default to 1 if not specified)
3. Determine the formula type based on context

Before providing the final JSON output, show your reasoning process inside <analysis> tags. Follow these steps:

1. Identify and Quote Information:
 - Quote mentions of the subject address
 - Quote mentions of withdrawal amount
 - Quote any references to formula type or trading patterns

2. Subject Address Validation:
 - Must start with "0x"
 - Must be exactly 42 characters long
 - Must follow hexadecimal format (0-9, a-f)

3. Amount Validation:
 - Must be a positive integer
 - Default to 1 if not specified
 - Cannot be zero
 - Must not exceed available curves balance (if mentioned)

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
 - Non-integer or invalid amounts
 - Unsupported formula types
 - Balance exceeded (if known)

6. Final Summary:
 - Verified subject address
 - Confirmed withdrawal amount
 - Selected formula with reasoning

After your analysis, provide the final output in a JSON markdown block:
\`\`\`json
{
  "subject": string,    // Validated Ethereum address
  "amount": number,     // Integer amount to withdraw
  "formula": string     // Either "QUADRATIC" or "LOGARITHMIC"
}
\`\`\`

Requirements:
- Subject: valid Ethereum address (0x... format, 42 chars)
- Amount: positive integer (defaults to 1)
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
  "amount": 5,
  "formula": "LOGARITHMIC"
}
\`\`\`

{{providers}}

Now, analyze the withdrawal request and provide your response.`;
