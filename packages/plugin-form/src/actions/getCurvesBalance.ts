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

interface GetCurvesBalanceParams {
    subject: string; // The subject's curves to check balance for
    owner?: string; // The address holding the curves tokens (defaults to connected wallet)
    formula: CurvesType; // The formula type (QUADRATIC or LOGARITHMIC)
}

export class GetCurvesBalanceAction {
    constructor(private wallet: FormWalletClient) {}

    async getBalance(params: GetCurvesBalanceParams) {
        const formula = params.formula || "QUADRATIC";

        elizaLogger.debug(
            `[plugin-form][get-curves-balance] checking balance for subject ${params.subject} ${params.owner ? `owned by ${params.owner}` : "owned by connected wallet"} using ${formula} formula`
        );

        const curvesAddress = this.wallet.getCurvesAddress(formula);
        if (!curvesAddress) {
            throw new Error(
                `No curves contract found for formula ${formula} on chain ${this.wallet.getChain().id}`
            );
        }

        const subjectAddress = await this.wallet.resolveAddress(params.subject);
        const ownerAddress = params.owner
            ? await this.wallet.resolveAddress(params.owner)
            : this.wallet.getAddress();

        // Get the balance
        const balance = await this.wallet.getCurvesTokenBalance(
            curvesAddress,
            ownerAddress,
            subjectAddress
        );

        return {
            subject: subjectAddress,
            owner: ownerAddress,
            balance: balance,
            formula: formula,
            curvesAddress: curvesAddress,
        };
    }
}

export const getCurvesBalanceAction: Action = {
    name: "get_curves_balance",
    description: "Check Curves token balance for an owner of a certain subject",
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
            "[plugin-form][get-curves-balance] action handler called"
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
        const action = new GetCurvesBalanceAction(wallet);

        try {
            const params = (await generateObjectDeprecated({
                runtime,
                context: composeContext({
                    state: currentState,
                    template: getCurvesBalanceTemplate,
                }),
                modelClass: ModelClass.SMALL,
            })) as GetCurvesBalanceParams;

            params.formula = params.formula ?? "QUADRATIC";

            const balanceResp = await action.getBalance(params);

            if (callback) {
                callback({
                    text: `Curves Balance Details:
Owner: ${balanceResp.owner}
Subject: ${balanceResp.subject}
Balance: ${balanceResp.balance} curves
Curves Formula: ${balanceResp.formula}
Curves Address: ${balanceResp.curvesAddress}`,
                    content: {
                        success: true,
                        subject: balanceResp.subject,
                        owner: balanceResp.owner,
                        balance: balanceResp.balance.toString(),
                        formula: balanceResp.formula,
                        curvesAddress: balanceResp.curvesAddress,
                    },
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error(
                "[plugin-form][get-curves-balance] error checking balance:",
                error
            );
            if (callback) {
                callback({
                    text: `Error checking curves balance: ${error.message}`,
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
                    text: "I'll help you check your curves balance for 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
                    action: "GET_CURVES_BALANCE",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "Show me my curves balance for 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
                    action: "GET_CURVES_BALANCE",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I'll help you check 0x742d35Cc6634C0532925a3b844Bc454e4438f44f curves balance for 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
                    action: "GET_CURVES_BALANCE",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "How many curves tokens of 0x742d35Cc6634C0532925a3b844Bc454e4438f44e do 0x742d35Cc6634C0532925a3b844Bc454e4438f44f have?",
                    action: "SHOW_CURVES_HOLDINGS",
                },
            },
        ],
    ],
    similes: [
        "GET_CURVES_BALANCE",
        "CHECK_CURVES_BALANCE",
        "VIEW_CURVES_AMOUNT",
        "SHOW_CURVES_HOLDINGS",
    ],
};

const getCurvesBalanceTemplate = `You are an AI assistant specialized in checking Form chain curves token balances. Your task is to extract the query parameters from the conversation context.

First, review the recent messages from the conversation:
<recent_messages>
{{recentMessages}}
</recent_messages>

Your goal is to extract:
1. Subject address (whose curves to check balance for)
2. Owner address (optional, who holds the curves tokens - defaults to connected wallet)
3. Determine the formula type based on context

Before providing the final JSON output, show your reasoning process inside <analysis> tags. Follow these steps:

1. Identify and Quote Information:
- Quote mentions of the subject address (whose curves)
- Quote mentions of the owner address (if different from connected wallet)
- Quote any references to formula type or trading patterns

2. Address Validation:
Subject Address:
- Must start with "0x"
- Must be exactly 42 characters long
- Must follow hexadecimal format (0-9, a-f)

Owner Address (if provided):
- Must start with "0x"
- Must be exactly 42 characters long
- Must follow hexadecimal format (0-9, a-f)
- If not specified, will use connected wallet

3. Formula Determination:
If formula is explicitly mentioned:
- QUADRATIC: Standard bonding curve
- LOGARITHMIC: For high volume or stability focus

If no formula mentioned, analyze:
- Look for keywords suggesting high volume/stability needs
- Consider mentioned use cases or patterns
- Default to QUADRATIC if context is unclear

4. Context Analysis:
- Is there a clear distinction between subject and owner?
- Are we checking someone else's holdings?
- Is the query about the connected wallet's holdings?

5. Final Summary:
- Confirmed subject address
- Owner address (specified or defaulting to connected wallet)
- Selected formula with reasoning

After your analysis, provide the final output in a JSON markdown block:
\`\`\`json
{
 "subject": string,     // Validated Ethereum address
 "owner": string|null,  // Optional validated Ethereum address or null for connected wallet
 "formula": string      // Either "QUADRATIC" or "LOGARITHMIC"
}
\`\`\`

Requirements:
- Subject: valid Ethereum address (0x... format, 42 chars)
- Owner: null or valid Ethereum address (0x... format, 42 chars)
- Formula: exactly "QUADRATIC" or "LOGARITHMIC" (defaults to "QUADRATIC")

Example valid outputs:

Checking connected wallet's holdings:
\`\`\`json
{
 "subject": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
 "owner": null,
 "formula": "QUADRATIC"
}
\`\`\`

Checking specific owner's holdings:
\`\`\`json
{
 "subject": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
 "owner": "0x123d35Cc6634C0532925a3b844Bc454e4438f789",
 "formula": "LOGARITHMIC"
}
\`\`\`

{{providers}}

Now, analyze the balance check request and provide your response.`;
