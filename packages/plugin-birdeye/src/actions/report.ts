import {
    Action,
    ActionExample,
    composeContext,
    elizaLogger,
    generateText,
    ModelClass,
    type IAgentRuntime,
    type Memory,
    type State
} from "@elizaos/core";
import { BirdeyeProvider } from "../providers/birdeye";

const extractTokenSymbolTemplate = `Given the recent message below:

{{recentMessages}}

Extract the 1 latest information about the requested token report:
- Input token symbol
- Extra about this symbol

When the symbol is specified in all lower case, such as btc, eth, sol..., we should convert it into wellknown symbol.
E.g. btc instead of BTC, sol instead of SOL.

But when we see them in mixed form, such as SOl, DOl, eTH we should keep the original and notice user instead.
When in doubt, specify the concern in the message field.

Respond exactly a JSON object containing only the extracted values, no extra description or message needed.
Use null for any values that cannot be determined. The result should be a valid JSON object with the following schema:
{
    "symbol": string | null,
    "message": string | null,
}

Examples:
  Message: "Tell me about BTC"
  Response: {
      "symbol": "BTC",
      "message": null
  }

  Message: "Do you know about SOl."
  Response:
  {
      "symbol": "SOl",
      "message": "Please note that the symbol is not in the standard format."
  }
`;


const formatTokenReport = (data) => {
    let output = `**Token Security and Trade Report**\n`;
    output += `Token symbol: ${data.symbol}\n`
    output += `Token Address: ${data.tokenAddress}\n\n`;

    output += `**Ownership Distribution:**\n`;
    output += `- Owner Balance: ${data.security.ownerBalance}\n`;
    output += `- Creator Balance: ${data.security.creatorBalance}\n`;
    output += `- Owner Percentage: ${data.security.ownerPercentage}%\n`;
    output += `- Creator Percentage: ${data.security.creatorPercentage}%\n`;
    output += `- Top 10 Holders Balance: ${data.security.top10HolderBalance}\n`;
    output += `- Top 10 Holders Percentage: ${data.security.top10HolderPercent}%\n\n`;

    // Trade Data
    output += `**Trade Data:**\n`;
    output += `- Holders: ${data.volume.holder}\n`;
    output += `- Unique Wallets (24h): ${data.volume.unique_wallet_24h}\n`;
    output += `- Price Change (24h): ${data.volume.price_change_24h_percent}%\n`;
    output += `- Price Change (12h): ${data.volume.price_change_12h_percent}%\n`;
    output += `- Volume (24h USD): $${data.volume.volume_24h_usd}\n`;
    output += `- Current Price: $${data.volume.price}\n\n`;

    return output
}

const extractTokenSymbol = async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: any,
    callback?: any) => {
    const context = composeContext({
        state,
        template: extractTokenSymbolTemplate
    })

    const response = await generateText({
        runtime,
        context,
        modelClass: ModelClass.LARGE,
    })

    try {
        const regex = new RegExp(/\{(.+)\}/gms);
        const normalized = response && regex.exec(response)?.[0]
        elizaLogger.debug('Normalized data', normalized)
        return normalized && JSON.parse(normalized)
    } catch {
        callback?.({text: response})
        return true
    }
}

export const reportToken = {
    name: "REPORT_TOKEN",
    similes: ["CHECK_TOKEN", "REVIEW_TOKEN", "TOKEN_DETAILS"],
    description: "Check background data for a given token",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback?: any
    ) => {
        try {
            const params = await extractTokenSymbol(
                runtime,
                message,
                state,
                options,
                callback
            )

            elizaLogger.debug('Params', params)

            if(!params?.symbol) {
                callback?.({text: "I need a token symbol to begin"})
                return true
            }

            if(params?.message) {
                callback?.({text: `I need more clarification to continue, ${params.message}`})
                return true
            }

            const symbol = params?.symbol
            elizaLogger.log('Fetching birdeye data', symbol)
            const provider = new BirdeyeProvider(runtime.cacheManager)

            const [tokenAddress, security, volume] = await Promise.all([
                provider.getTokenAddress(symbol),
                provider.fetchTokenSecurityBySymbol(symbol),
                provider.fetchTokenTradeDataBySymbol(symbol),
            ]);

            elizaLogger.log('Fetching birdeye done')
            const msg = formatTokenReport({
                symbol,
                tokenAddress,
                security: security.data,
                volume: volume.data
            })
            callback?.({text: msg})
            return true
        } catch (error) {
            console.error("Error in reportToken handler:", error.message);
            callback?.({ text: `Error: ${error.message}` });
            return false;
        }
    },
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        return true;
    },
    examples: [
        [
            {
                user: "user",
                content: {
                    text: "Tell me what you know about SOL",
                    action: "CHECK_TOKEN",
                },
            },
            {
                user: "user",
                content: {
                    text: "Do you know about SOL",
                    action: "TOKEN_DETAILS",
                },
            },
            {
                user: "user",
                content: {
                    text: "Tell me about WETH",
                    action: "REVIEW_TOKEN",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
