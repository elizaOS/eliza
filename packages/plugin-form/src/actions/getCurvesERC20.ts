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

interface GetCurvesERC20DetailsParams {
    subject?: string; // Optional subject address to query (defaults to connected wallet)
    formula: CurvesType; // The formula type (QUADRATIC or LOGARITHMIC)
}

export class GetCurvesERC20DetailsAction {
    constructor(private wallet: FormWalletClient) {}

    async getDetails(params: GetCurvesERC20DetailsParams) {
        const formula = params.formula || "QUADRATIC";

        elizaLogger.debug(
            `[plugin-form][get-curves-erc20-details] fetching ERC20 details for ${params.subject || "connected wallet"} using ${formula} formula`
        );

        const curvesAddress = this.wallet.getCurvesAddress(formula);
        if (!curvesAddress) {
            throw new Error(
                `No curves contract found for formula ${formula} on chain ${this.wallet.getChain().id}`
            );
        }

        // If subject provided, resolve it, otherwise use connected wallet
        const subjectAddress = params.subject
            ? await this.wallet.resolveAddress(params.subject)
            : this.wallet.getAddress();

        // Get ERC20 token details
        const erc20Info = await this.wallet.getCurvesERC20TokenDetails(
            curvesAddress,
            subjectAddress
        );

        return {
            subject: subjectAddress,
            formula: formula,
            curvesAddress: curvesAddress,
            erc20Token: erc20Info,
        };
    }
}

export const getCurvesERC20DetailsAction: Action = {
    name: "get_curves_erc20_details",
    description: "Get ERC20 token details for Curves holdings",
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
            "[plugin-form][get-curves-erc20-details] action handler called"
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
        const action = new GetCurvesERC20DetailsAction(wallet);

        try {
            const params = (await generateObjectDeprecated({
                runtime,
                context: composeContext({
                    state: currentState,
                    template: getERC20DetailsTemplate,
                }),
                modelClass: ModelClass.SMALL,
            })) as GetCurvesERC20DetailsParams;

            params.formula = params.formula ?? "QUADRATIC";

            const detailsResp = await action.getDetails(params);

            if (callback) {
                callback({
                    text: `ERC20 Token Details:
Name: ${detailsResp.erc20Token.name}
Symbol: ${detailsResp.erc20Token.symbol}
Address: ${detailsResp.erc20Token.address}
Decimals: ${detailsResp.erc20Token.decimals}
Owner: ${detailsResp.subject}`,
                    content: {
                        success: true,
                        subject: detailsResp.subject,
                        formula: detailsResp.formula,
                        curvesAddress: detailsResp.curvesAddress,
                        erc20Token: detailsResp.erc20Token,
                    },
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error(
                "[plugin-form][get-curves-erc20-details] error getting token details:",
                error
            );
            if (callback) {
                callback({
                    text: `Error getting ERC20 token details: ${error.message}`,
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
                    text: "I'll help you get ERC20 token details for your curves",
                    action: "GET_CURVES_ERC20_DETAILS",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "Show me my curves ERC20 token details",
                    action: "GET_CURVES_ERC20_DETAILS",
                },
            },
        ],
    ],
    similes: [
        "GET_CURVES_ERC20_DETAILS",
        "SHOW_CURVES_TOKEN",
        "VIEW_ERC20_INFO",
    ],
};

const getERC20DetailsTemplate = `You are an AI assistant specialized in retrieving Form chain ERC20 token details. Your task is to extract the query parameters from the conversation context.

First, review the recent messages from the conversation:
<recent_messages>
{{recentMessages}}
</recent_messages>

Your goal is to extract:
1. Optional subject address (defaults to connected wallet if not specified)
2. Determine the formula type based on context

Before providing the final JSON output, show your reasoning process inside <analysis> tags. Follow these steps:

1. Identify and Quote Information:
 - Quote any mention of a specific address to query (if present)
 - Quote any references to formula type or trading patterns
 - Quote any context about whose token details are being requested

2. Optional Subject Address Validation (if provided):
 - Must start with "0x"
 - Must be exactly 42 characters long
 - Must follow hexadecimal format (0-9, a-f)
 - If no address mentioned, will use connected wallet

3. Formula Determination:
 If formula is explicitly mentioned:
 - QUADRATIC: Standard bonding curve
 - LOGARITHMIC: For high volume or stability focus

 If no formula mentioned, analyze:
 - Look for keywords suggesting high volume/stability needs
 - Consider mentioned use cases or patterns
 - Default to QUADRATIC if context is unclear

4. Final Summary:
 - Note if using specified address or defaulting to connected wallet
 - Selected formula with reasoning

After your analysis, provide the final output in a JSON markdown block:
\`\`\`json
{
  "subject": string | null,  // Optional Ethereum address or null for connected wallet
  "formula": string          // Either "QUADRATIC" or "LOGARITHMIC"
}
\`\`\`

Requirements:
- Subject: null or valid Ethereum address (0x... format, 42 chars)
- Formula: exactly "QUADRATIC" or "LOGARITHMIC" (defaults to "QUADRATIC")

Example valid outputs:

For connected wallet:
\`\`\`json
{
  "subject": null,
  "formula": "QUADRATIC"
}
\`\`\`

For specific address:
\`\`\`json
{
  "subject": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
  "formula": "LOGARITHMIC"
}
\`\`\`

{{providers}}

Now, analyze the token details request and provide your response.`;
