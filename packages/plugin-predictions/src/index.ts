import { elizaLogger, generateText, ModelClass } from "@ai16z/eliza";
import {
    Action,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    Plugin,
    State,
} from "@ai16z/eliza";
import { validatePredictionsConfig } from "./environment";
import { ApiResponse, TokenData, TokenTradeData, TradeDataResponse, ParsedInput } from "./types";
import { searchCashTags, fetchTokenCreation } from "./utils";

const baseUrl = "https://public-api.birdeye.so";

const fetchTradeData = async (runtime: IAgentRuntime, tokenAddress: string, chain: string): Promise<TokenTradeData> => {
    //console.log("Fetching trade data for token address:", tokenAddress);
    const tradeUrl = `${baseUrl}/defi/v3/token/trade-data/single?address=${tokenAddress}`;

    const apiKey = runtime.getSetting("BIRDEYE_API_KEY");

    const tradeResponse = await fetch(tradeUrl, {
        method: "GET",
        headers: {
            accept: "application/json",
            'x-chain': chain || 'solana',
            'X-API-KEY': apiKey,
        },
    });
    console.log("Trade response:", tradeResponse);
    if (!tradeResponse.ok) {
        throw new Error(`API request for trade data failed: ${tradeResponse.status}`);
    }

    const tradeDataResponse = (await tradeResponse.json()) as TradeDataResponse;
    if (!tradeDataResponse.success) {
        throw new Error(`API request for trade data failed: ${tradeDataResponse.error}`);
    }
    const tradeData = tradeDataResponse.data;
    // combine the dat
    console.log('tradeData:', tradeData);
    return tradeData;
};

const fetchTokenOtherwise = async (runtime: IAgentRuntime, tokenAddress: string, chain: string): Promise<TokenData> => {
    try {
        const tradeUrl = `${baseUrl}/defi/token_overview?address=${tokenAddress}`;

        const apiKey = runtime.getSetting("BIRDEYE_API_KEY");

        const dataResponse = await fetch(tradeUrl, {
            method: "GET",
            headers: {
                accept: "application/json",
                'x-chain': chain || 'solana',
                'X-API-KEY': apiKey,
            },
        });

        const data = await dataResponse.json() as ApiResponse;
        if (!data.success) {
            throw new Error(`API request for token data failed: ${data.error}`);
        }
        return data.data;
    } catch (error) {
        console.error("Error in fetchTokenOtherwise:", error);
        return null;
    }
}

const cashtagHandlerTemplate = `
# Instructions: Give a detailed analysis of the token pair. Split youur response into 4 sections. Each section should be detailed but concise.

1. Overview of the token data and a brief analysis of the token.
2. Form a thesis on the token pair based on the token data.
3. Calculate the "degen score" with your reasoning.
4. Give a prediction for the token pair.

# Example:

Quantitative analysis on token pair <symbol>/<symbol>

<Overview>

<Thesis>

<Degen Score>

<Prediction>

# Additional instructions: Use line breaks to separate your sections with \n\n.
`;

const formatResponseText = (bestMatch, tradeData, cashtag) => `
Best match for $${cashtag}:
Token: ${bestMatch.baseToken.name} (${bestMatch.baseToken.symbol})
MCAP: $${bestMatch.marketCap.toFixed(2)}M
Age: ${Math.floor((Date.now() - bestMatch.pairCreatedAt) / (1000 * 60 * 60 * 24))} days
Liquidity: $${bestMatch.liquidity.usd.toLocaleString()}
24h Volume: $${bestMatch.volume.h24.toLocaleString()}
24h Transactions: ${(bestMatch.txns.h24.buys + bestMatch.txns.h24.sells).toLocaleString()}
Price: $${bestMatch.priceUsd}
DEX: ${bestMatch.dexId}
Pair Address: ${bestMatch.pairAddress}
Last Trade: ${tradeData.last_trade_human_time}
Price Change 30m: ${tradeData.price_change_30m_percent}%
Price Change 1h: ${tradeData.price_change_1h_percent}%
Price Change 24h: ${tradeData.price_change_24h_percent}%
Volume 30m USD: $${tradeData.volume_30m_usd.toLocaleString()}
Volume History 30m USD: $${tradeData.volume_history_30m_usd.toLocaleString()}
Volume 30m Change: ${tradeData.volume_30m_change_percent}%
URL: ${bestMatch.url}`;

const formatTokenResponseText = (tokenData, tokenCreation, cashtag) => `
Best match for $${cashtag}:
Token: ${tokenData.name} (${tokenData.symbol})
MCAP: $${tokenData.mc.toFixed(2)}M
Age: ${Math.floor((Date.now() - tokenCreation) / (1000 * 60 * 60 * 24))} days
Liquidity: $${tokenData.liquidity.toLocaleString()}
24h Volume: $${tokenData.vHistory2hUSD.toLocaleString()}
24h Transactions: ${(tokenData.vBuyHistory24hUSD + tokenData.vSellHistory24hUSD).toLocaleString()}
Price: $${tokenData.price}
Last Trade: ${tokenData.lastTradeHumanTime}
Price Change 30m: ${tokenData.priceChange30mPercent}%
Price Change 1h: ${tokenData.priceChange1hPercent}%
Price Change 24h: ${tokenData.priceChange24hPercent}%
Volume 30m USD: $${tokenData.v30mUSD.toLocaleString()}
Volume History 30m USD: $${tokenData.vHistory30mUSD.toLocaleString()}
Volume 30m Change: ${tokenData.v30mChangePercent}%`;

const generateResponseContent = async (runtime, responseText, cashtagHandlerTemplate) => {
    const systemPromptTg = `You are a crypto analyst with a focus on the Solana ecosystem.

    CORE DIRECTIVES:
        1. analyze the data of the token pair and make a probabilistic prediction about the future of the token pair.
        2. Use symbols like (∞, ∑, ∆) to make your predictions more interesting and visual occasionally. never use hashtags.
        3. your analysis should be based on the data provided and should be logical.
        4. don't be overly bullish or bearish. be neutral. give a detailed analysis.
        5. EXTRA: create a "degen score" which is a secret formula created by DEGEN8BALL.exe based on the data provided, be very specific.
        6. break up your response using new lines with \n\n.
        7. response should include a token analysis, then your prediction, then yourr degen score. Be as detailed as possible, making sure to back up your prediction and anlaysis with the data.
        8. DO NOT INCUDE DISCLAIMERS.
        9. Your analysis should be well formatted and easy to read.
        10. Your analysis is as accurate as possible.
`;

    return await generateText({
        runtime,
        systemPrompt: systemPromptTg,
        context: `${cashtagHandlerTemplate} + ${responseText}`,
        modelClass: ModelClass.SMALL,
    });
};

const parseInput = (text: string): ParsedInput | null => {
    const extractChain = text.match(/chain_id:\s*(\w+)/)?.[1];
    const chain = extractChain || "solana";

    if (text.includes("$")) {
        return { type: 'cashtag' as const, value: text.match(/\$[A-Za-z0-9]+/)?.[0]?.replace("$", ""), chain };
    }
    if (text.match(/0x[a-fA-F0-9]{40}/)) {
        return { type: 'eth' as const, value: text.match(/(\S+)\s+chain_id:/)?.[1], chain };
    }
    if (text.match(/[A-Za-z0-9]{32,44}/)) {
        return { type: 'sol' as const, value: text.match(/(\S+)\s+chain_id:/)?.[1], chain };
    }
    return null;
};

// Data Fetcher
const fetchTokenData = async (input: ParsedInput, runtime: IAgentRuntime) => {
    switch(input.type) {
        case 'cashtag':
            const { data: bestMatch } = await searchCashTags(input.value);
            const tradeData = await fetchTradeData(runtime, bestMatch.baseToken.address, input.chain);
            return { bestMatch, tradeData };
        case 'eth':
        case 'sol':
            const tokenData = await fetchTokenOtherwise(runtime, input.value, input.chain);
            const tokenCreation = await fetchTokenCreation(input.value, input.chain);
            return { tokenData, tokenCreation };
    }
};

const prediction: Action = {
    name: "PREDICTION",
    similes: [
        "PREDICTION",
        "PREDICT",
        "PREDICT_A",
        "PREDICT_TOKEN",
        "MAKE_PREDICTION",
        "FORECAST_TOKEN",
        "PREDICT_THIS",
        "GIVE_PREDICTION"
    ],
    description: "Generate a prediction to go along with the message.",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        await validatePredictionsConfig(runtime);

        const birdeyeApiKeyOk = !!runtime.getSetting("BIRDEYE_API_KEY");

        return birdeyeApiKeyOk;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: {},
        callback: HandlerCallback
    ) => {
        elizaLogger.log("Composing state for message:", message);
        state = (await runtime.composeState(message)) as State;
        const userId = runtime.agentId;
        elizaLogger.log("User ID:", userId);
        const text = message.content.text;
        console.log('Extracted text:', text);

        try {
            const input = parseInput(message.content.text);
            if (!input) {
                return;
            }

            const data = await fetchTokenData(input, runtime);
            if (!data) {
                callback({ text: "No data found" });
                return;
            }

            const responseText = input.type === 'cashtag'
                ? formatResponseText(data.bestMatch, data.tradeData, input.value)
                : formatTokenResponseText(data.tokenData, data.tokenCreation, input.value);
            const responseContent = await generateResponseContent(runtime, responseText, cashtagHandlerTemplate);

            callback({ text: responseContent });
        } catch (error) {
            callback({ text: `Error: ${error.message}` });
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Can you give me a prediction on $PNUT?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Let me search for the best matching pair...",
                    action: "PREDICTION",
                },
            },
        ],
    ],
} as Action;

export const predictionPlugin: Plugin = {
    name: "prediction",
    description: "Generate predictions",
    actions: [prediction],
    evaluators: [],
    providers: [],
};
