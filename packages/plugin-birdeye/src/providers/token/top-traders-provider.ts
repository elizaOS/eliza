import {
    IAgentRuntime,
    Memory,
    Provider,
    State,
    elizaLogger,
} from "@elizaos/core";
import { BASE_URL, Chain, makeApiRequest } from "../utils";

// Types
interface Trader {
    address: string;
    tradeCount: number;
    volume: number;
    profit: number;
    lastTradeTime: number;
}

interface TopTradersResponse {
    traders: Trader[];
}

// Constants
const TOP_TRADERS_KEYWORDS = [
    "top traders",
    "best traders",
    "leading traders",
    "most successful traders",
    "highest volume traders",
] as const;

// Helper functions
const containsTopTradersKeyword = (text: string): boolean => {
    return TOP_TRADERS_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const getTopTraders = async (
    apiKey: string,
    chain: Chain = "solana"
): Promise<TopTradersResponse | null> => {
    try {
        const url = `${BASE_URL}/token/top_traders`;

        elizaLogger.info("Fetching top traders from:", url);

        return await makeApiRequest<TopTradersResponse>(url, { apiKey, chain });
    } catch (error) {
        if (error instanceof Error) {
            elizaLogger.error("Error fetching top traders:", error.message);
        }
        return null;
    }
};

const formatTopTradersResponse = (data: TopTradersResponse): string => {
    let response = "🏆 Top Traders\n\n";

    data.traders.forEach((trader, index) => {
        const lastTradeDate = new Date(
            trader.lastTradeTime * 1000
        ).toLocaleString();
        const profitPrefix = trader.profit >= 0 ? "+" : "";

        response += `${index + 1}. Trader ${trader.address.slice(0, 8)}...${trader.address.slice(-6)}\n`;
        response += `• Trade Count: ${trader.tradeCount.toLocaleString()}\n`;
        response += `• Volume: $${trader.volume.toLocaleString()}\n`;
        response += `• Profit: ${profitPrefix}$${trader.profit.toLocaleString()}\n`;
        response += `• Last Trade: ${lastTradeDate}\n\n`;
    });

    return response.trim();
};

export const topTradersProvider: Provider = {
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

        if (!containsTopTradersKeyword(messageText)) {
            return null;
        }

        elizaLogger.info("TOP_TRADERS provider activated");

        const tradersData = await getTopTraders(apiKey);

        if (!tradersData) {
            return null;
        }

        return formatTopTradersResponse(tradersData);
    },
};
