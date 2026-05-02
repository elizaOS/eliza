import {
    type Action,
    type ActionExample,
    elizaLogger,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
} from "@elizaos/core";
import { BirdeyeProvider } from "../birdeye";
import type { TokenResult } from "../types/api/search";
import {
    extractSymbols,
    formatPercentChange,
    formatPrice,
    formatValue,
} from "../utils";

// "strict" requires a $ prefix and will match $SOL, $ai16z, $BTC, etc.
// "loose" will match $SOL, SOL, SOLANA, etc. and does not require a $ prefix but may interpret any other acronyms as symbols to search for
const SYMBOL_SEARCH_MODE = "strict";

export const tokenSearchSymbolAction = {
    name: "BIRDEYE_TOKEN_SEARCH_SYMBOL",
    similes: [
        "SEARCH_TOKEN_SYMBOL",
        "FIND_TOKEN_SYMBOL",
        "LOOKUP_TOKEN_SYMBOL",
        "CHECK_TOKEN_SYMBOL",
        "GET_TOKEN_BY_SYMBOL",
        "SYMBOL_SEARCH",
        "SYMBOL_LOOKUP",
        "SYMBOL_CHECK",
        "TOKEN_SYMBOL_INFO",
        "TOKEN_SYMBOL_DETAILS",
        "TOKEN_SYMBOL_LOOKUP",
        "TOKEN_SYMBOL_SEARCH",
        "TOKEN_SYMBOL_CHECK",
        "TOKEN_SYMBOL_QUERY",
        "TOKEN_SYMBOL_FIND",
        "GET_TOKEN_INFO",
        "TOKEN_INFO",
        "TOKEN_REPORT",
        "TOKEN_ANALYSIS",
        "TOKEN_OVERVIEW",
        "TOKEN_SUMMARY",
        "TOKEN_INSIGHT",
        "TOKEN_DATA",
        "TOKEN_STATS",
        "TOKEN_METRICS",
        "TOKEN_PROFILE",
        "TOKEN_REVIEW",
        "TOKEN_CHECK",
        "TOKEN_LOOKUP",
        "TOKEN_FIND",
        "TOKEN_DISCOVER",
        "TOKEN_EXPLORE",
    ],
    description:
        "Search for detailed token information including security and trade data by symbol",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state: State,
        _options: Record<string, unknown>,
        callback?: HandlerCallback
    ) => {
        try {
            const provider = new BirdeyeProvider(runtime);

            // get all symbols from the message that match (i.e. $SOL, $ETH, $BTC, etc.). If you want to match more loosely, use "loose" instead of "strict" and it will match $SOL, SOL, SOLANA, etc.
            const symbols = extractSymbols(
                message.content?.text ?? "",
                SYMBOL_SEARCH_MODE
            );

            elizaLogger.info(
                `Searching Birdeye provider for ${symbols.length} symbols`
            );

            // for each symbol, do a search in Birdeye. This will return a list of token results that may be amatch to the token symbol.
            const results = await Promise.all(
                symbols.map((symbol) =>
                    provider.fetchSearchTokenMarketData({
                        keyword: symbol,
                        sort_by: "volume_24h_usd",
                        sort_type: "desc",
                        chain: "all",
                        limit: 5,
                    })
                )
            );

            // get filter the results to only include the token results and then filter the results to only include the ones that match the symbol
            const validResults = results.map((r, i) =>
                r.data.items
                    .filter((item) => item.type === "token" && item.result)
                    .flatMap((item) =>
                        (item.result as TokenResult[]).filter(
                            (r) =>
                                r.symbol?.toLowerCase() ===
                                symbols[i].toLowerCase()
                        )
                    )
            ) as TokenResult[][];

            if (validResults.length === 0) {
                callback?.({ text: "No token results found for the symbols you searched." });
                return;
            }

            const completeResults = `I performed a search for the token symbols you requested and found the following results (for more details search by contract address):\n\n${validResults
                .map(
                    (result, i) =>
                        `${formatTokenSummary(symbols[i], i, result)}`
                )
                .join("\n")}`;

            callback?.({ text: completeResults });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            runtime.logger?.error("Error in searchTokens handler:", errorMessage);
            callback?.({ text: `Error: ${errorMessage}` });
        }
    },
    validate: async (_runtime: IAgentRuntime, message: Memory) => {
        const symbols = extractSymbols(
            message.content?.text ?? "",
            SYMBOL_SEARCH_MODE
        );
        return symbols.length > 0;
    },
    examples: [
        [
            {
                name: '{{name1}}',
                content: {
                    text: "Search for $SOL and $ETH",
                },
            },
            {
                name: '{{name2}}',
                content: {
                    text: "Searching for $SOL and $ETH",
                    actions: ["SEARCH_TOKENS"],
                },
            },
        ],[
            {
                name: '{{name1}}',
                content: {
                    text: "Find information about $BTC",
                },
            },
            {
                name: '{{name2}}',
                content: {
                    text: "Finding information about $BTC",
                    actions: ["TOKEN_SEARCH"],
                },
            },
        ],[
            {
                name: '{{name1}}',
                content: {
                    text: "Look up $WETH token",
                },
            },
            {
                name: '{{name2}}',
                content: {
                    text: "Looking up $WETH token",
                    actions: ["LOOKUP_TOKENS"],
                },
            },
        ],[
            {
                name: '{{name1}}',
                content: {
                    text: "Tell me about SOL",
                },
            },
            {
                name: '{{name2}}',
                content: {
                    text: "About SOL",
                    actions: ["CHECK_TOKEN"],
                },
            },
        ],[
            {
                name: '{{name1}}',
                content: {
                    text: "Give me details on $ADA",
                },
            },
            {
                name: '{{name2}}',
                content: {
                    text: "Here are details on $ADA",
                    actions: ["TOKEN_DETAILS"],
                },
            },
        ],[
            {
                name: '{{name1}}',
                content: {
                    text: "What can you tell me about $DOGE?",
                },
            },
            {
                name: '{{name2}}',
                content: {
                    text: "$DOGE info",
                    actions: ["TOKEN_INFO"],
                },
            },
        ],[
            {
                name: '{{name1}}',
                content: {
                    text: "I need a report on $XRP",
                },
            },
            {
                name: '{{name2}}',
                content: {
                    text: "Here's a report on $XRP",
                    actions: ["TOKEN_REPORT"],
                },
            },
        ],[
            {
                name: '{{name1}}',
                content: {
                    text: "Analyze $BNB for me",
                },
            },
            {
                name: '{{name2}}',
                content: {
                    text: "$BNB Anaylsis",
                    actions: ["TOKEN_ANALYSIS"],
                },
            },
        ],[
            {
                name: '{{name1}}',
                content: {
                    text: "Overview of $LTC",
                    actions: ["TOKEN_OVERVIEW"],
                },
            },
            {
                name: '{{name2}}',
                content: {
                    text: "Here's a overview of $LTC",
                    actions: ["TOKEN_OVERVIEW"],
                },
            },
        ],
    ] as ActionExample[][],
} as Action;

const formatTokenSummary = (
    symbol: string,
    _index: number,
    tokens: TokenResult[]
) => {
    return tokens
        .map((token, i) => {
            let output = "";
            if (i === 0) {
                output += `Search Results for ${symbol}:\n\n`;
            }
            output += `Search Result #${tokens.length > 0 ? i + 1 : ""}:\n`;
            output += `🔖 Symbol: $${token?.symbol?.toUpperCase()}\n`;
            output += `🔗 Address: ${token.address}\n`;
            output += `🌐 Network: ${token.network?.toUpperCase() ?? "N/A"}\n`;
            output += `💵 Price: ${formatPrice(token.price)} (${formatPercentChange(token.price_change_24h_percent)})\n`;
            output += `💸 Volume (24h USD): ${formatValue(token.volume_24h_usd)}\n`;
            output += token.market_cap
                ? `💰 Market Cap: ${formatValue(token.market_cap)}\n`
                : "";
            output += token.fdv ? `🌊 FDV: ${formatValue(token.fdv)}\n` : "";
            return output;
        })
        .join("\n");
};
