import {
    IAgentRuntime,
    Memory,
    Provider,
    State,
    elizaLogger,
} from "@elizaos/core";
import { BASE_URL, Chain, makeApiRequest } from "../utils";

// Types
interface Market {
    address: string;
    name: string;
    symbol: string;
    baseToken: string;
    quoteToken: string;
    volume24h: number;
    tvl: number;
    lastTradeTime: number;
}

interface AllMarketsResponse {
    markets: Market[];
}

// Constants
const MARKET_LIST_KEYWORDS = [
    "all markets",
    "market list",
    "trading pairs",
    "available markets",
    "list markets",
    "show markets",
] as const;

// Helper functions
const containsMarketListKeyword = (text: string): boolean => {
    return MARKET_LIST_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const getAllMarkets = async (
    apiKey: string,
    chain: Chain = "solana"
): Promise<AllMarketsResponse | null> => {
    try {
        const url = `${BASE_URL}/token/all_market_list`;

        elizaLogger.info("Fetching all markets from:", url);

        return await makeApiRequest<AllMarketsResponse>(url, { apiKey, chain });
    } catch (error) {
        if (error instanceof Error) {
            elizaLogger.error("Error fetching markets:", error.message);
        }
        return null;
    }
};

const formatAllMarketsResponse = (data: AllMarketsResponse): string => {
    let response = "📊 Available Markets\n\n";

    // Sort markets by volume
    const sortedMarkets = [...data.markets].sort(
        (a, b) => b.volume24h - a.volume24h
    );

    sortedMarkets.forEach((market) => {
        const lastTradeDate = new Date(
            market.lastTradeTime * 1000
        ).toLocaleString();

        response += `${market.name} (${market.symbol})\n`;
        response += `• Address: ${market.address}\n`;
        response += `• Base Token: ${market.baseToken}\n`;
        response += `• Quote Token: ${market.quoteToken}\n`;
        response += `• 24h Volume: $${market.volume24h.toLocaleString()}\n`;
        response += `• TVL: $${market.tvl.toLocaleString()}\n`;
        response += `• Last Trade: ${lastTradeDate}\n\n`;
    });

    return response.trim();
};

export const allMarketListProvider: Provider = {
    get: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State
    ): Promise<string | null> => {
        const apiKey = runtime.getSetting("BIRDEYE_API_KEY");
        if (!apiKey) {
            elizaLogger.error("BIRDEYE_API_KEY not found in runtime settings");
            return null;
        }

        const messageText = message.content.text;

        if (!containsMarketListKeyword(messageText)) {
            return null;
        }

        elizaLogger.info("ALL_MARKET_LIST provider activated");

        const marketsData = await getAllMarkets(apiKey);

        if (!marketsData) {
            return null;
        }

        return formatAllMarketsResponse(marketsData);
    },
};
