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

interface MintCurvesERC20Params {
    name: string; // ERC20 token name
    symbol: string; // ERC20 token symbol
    formula: CurvesType; // The formula type (QUADRATIC or LOGARITHMIC)
}

export class MintCurvesERC20TokenAction {
    constructor(private wallet: FormWalletClient) {}

    async mint(params: MintCurvesERC20Params) {
        const formula = params.formula || "QUADRATIC";

        elizaLogger.debug(
            `[plugin-form][mint-curves-erc20] minting ERC20 token "${params.name}" (${params.symbol}) using ${formula} formula`
        );

        const curvesAddress = this.wallet.getCurvesAddress(formula);
        if (!curvesAddress) {
            throw new Error(
                `No curves contract found for formula ${formula} on chain ${this.wallet.getChain().id}`
            );
        }

        // Execute mint transaction
        const tx = await this.wallet.mintCurvesERC20Token(
            curvesAddress,
            params.name,
            params.symbol
        );

        // Get the newly minted token details
        const erc20Info = await this.wallet.getCurvesERC20TokenDetails(
            curvesAddress,
            this.wallet.getAddress()
        );

        return {
            hash: tx.transactionHash,
            walletAddress: this.wallet.getAddress(),
            name: params.name,
            symbol: params.symbol,
            formula: formula,
            curvesAddress: curvesAddress,
            erc20Token: erc20Info,
        };
    }
}

export const mintCurvesERC20TokenAction: Action = {
    name: "mint_curves_erc20_token",
    description: "Mint a new ERC20 token for Curves holdings",
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
            "[plugin-form][mint-curves-erc20] action handler called"
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
        const action = new MintCurvesERC20TokenAction(wallet);

        try {
            const mintParams = (await generateObjectDeprecated({
                runtime,
                context: composeContext({
                    state: currentState,
                    template: mintCurvesERC20Template,
                }),
                modelClass: ModelClass.SMALL,
            })) as MintCurvesERC20Params;

            mintParams.formula = mintParams.formula ?? "QUADRATIC";

            const mintResp = await action.mint(mintParams);

            if (callback) {
                callback({
                    text: `Successfully minted ERC20 token "${mintResp.name}" (${mintResp.symbol})\nTransaction Hash: ${mintResp.hash}\nERC20 Token Address: ${mintResp.erc20Token.address}`,
                    content: {
                        success: true,
                        hash: mintResp.hash,
                        subject: wallet.getAddress(),
                        name: mintResp.name,
                        symbol: mintResp.symbol,
                        formula: mintResp.formula,
                        curvesAddress: mintResp.curvesAddress,
                        erc20Token: mintResp.erc20Token,
                    },
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error(
                "[plugin-form][mint-curves-erc20] error during token minting:",
                error
            );
            if (callback) {
                callback({
                    text: `Error minting ERC20 token: ${error.message}`,
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
                    text: "I'll help you mint an ERC20 token 'Community Token' with symbol 'CT' for 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
                    action: "MINT_CURVES_ERC20",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "Create ERC20 token for my curves at 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
                    action: "MINT_CURVES_ERC20",
                },
            },
        ],
    ],
    similes: ["MINT_CURVES_ERC20", "CREATE_CURVES_TOKEN", "NEW_CURVES_ERC20"],
};

const mintCurvesERC20Template = `You are an AI assistant specialized in minting Form chain ERC20 tokens for Curves. Your task is to extract token information and determine the appropriate formula from the conversation context. The mint will be executed using the connected wallet address.

First, review the recent messages from the conversation:
<recent_messages>
{{recentMessages}}
</recent_messages>

Your goal is to extract:
1. ERC20 token name (must be valid token name)
2. ERC20 token symbol (must be valid token symbol)
3. Determine the formula type based on context

Before providing the final JSON output, show your reasoning process inside <analysis> tags. Follow these steps:

1. Identify and Quote Information:
 - Quote mentions of token name
 - Quote mentions of token symbol
 - Quote any references to formula type or trading patterns

2. Token Name Validation:
 - Must be 1-32 characters long
 - Can include letters, numbers, and spaces
 - Cannot contain special characters except spaces
 - Must be meaningful and descriptive

3. Token Symbol Validation:
 - Must be 1-8 characters long
 - Uppercase letters and numbers only
 - No spaces or special characters
 - Should represent the token name

4. Formula Determination:
 If formula is explicitly mentioned:
 - QUADRATIC: Standard bonding curve
 - LOGARITHMIC: For high volume or stability focus

 If no formula mentioned, analyze:
 - Look for keywords suggesting high volume/stability needs
 - Consider mentioned use cases or patterns
 - Default to QUADRATIC if context is unclear

5. Error Checking:
 - Invalid token name format or length
 - Invalid symbol format or length
 - Unsupported formula types
 - Name/symbol already in use (if mentioned)

6. Final Summary:
 - Validated token name and symbol
 - Selected formula with reasoning

After your analysis, provide the final output in a JSON markdown block:
\`\`\`json
{
  "name": string,       // Token name (1-32 chars)
  "symbol": string,     // Token symbol (1-8 chars, uppercase)
  "formula": string     // Either "QUADRATIC" or "LOGARITHMIC"
}
\`\`\`

Requirements:
- Name: 1-32 characters, letters/numbers/spaces only
- Symbol: 1-8 characters, uppercase letters/numbers only
- Formula: exactly "QUADRATIC" or "LOGARITHMIC" (defaults to "QUADRATIC")

Example valid outputs:
\`\`\`json
{
  "name": "Shiba v2",
  "symbol": "SHV2",
  "formula": "QUADRATIC"
}
\`\`\`

\`\`\`json
{
  "name": "Space Dreamers",
  "symbol": "SPDR",
  "formula": "LOGARITHMIC"
}
\`\`\`

{{providers}}

Now, analyze the minting request and provide your response.`;
