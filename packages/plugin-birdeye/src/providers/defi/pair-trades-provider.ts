import {
    IAgentRuntime,
    Memory,
    Provider,
    State,
    elizaLogger,
} from "@elizaos/core";
import {
    BASE_URL,
    Chain,
    extractChain,
    extractContractAddresses,
    extractLimit,
    formatTimestamp,
    formatValue,
    makeApiRequest,
    shortenAddress,
} from "../utils";

// Types
interface PairTrade {
    timestamp: number;
    price: number;
    volume: number;
    side: "buy" | "sell";
    source: string;
    txHash: string;
    buyer?: string;
    seller?: string;
    baseToken: string;
    quoteToken: string;
}

interface PairTradesResponse {
    trades: PairTrade[];
    totalCount: number;
    pair: {
        baseToken: string;
        quoteToken: string;
    };
}

// Constants
const PAIR_TRADES_KEYWORDS = [
    "pair trades",
    "pair swaps",
    "pair transactions",
    "pair activity",
    "pair orders",
    "pair executions",
    "pair trading",
    "pair market activity",
    "pair exchange activity",
    "pair trading history",
    "pair market history",
    "pair exchange history",
    "trading pair activity",
    "trading pair history",
    "base/quote trades",
    "base/quote activity",
] as const;

// Helper functions
const containsPairTradesKeyword = (text: string): boolean => {
    return PAIR_TRADES_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const getPairTrades = async (
    apiKey: string,
    baseAddress: string,
    quoteAddress: string,
    chain: Chain,
    limit: number
): Promise<PairTradesResponse | null> => {
    try {
        const params = new URLSearchParams({
            base_address: baseAddress,
            quote_address: quoteAddress,
            limit: limit.toString(),
        });
        const url = `${BASE_URL}/defi/trades_pair?${params.toString()}`;

        elizaLogger.info(
            `Fetching pair trades for base ${baseAddress} and quote ${quoteAddress} on ${chain} from:`,
            url
        );

        return await makeApiRequest<PairTradesResponse>(url, { apiKey, chain });
    } catch (error) {
        if (error instanceof Error) {
            elizaLogger.error("Error fetching pair trades:", error.message);
        }
        return null;
    }
};

const formatPairTrade = (trade: PairTrade): string => {
    const timestamp = formatTimestamp(trade.timestamp);
    const side = trade.side === "buy" ? "🟢 Buy" : "🔴 Sell";

    let response = `${side} - ${timestamp}\n`;
    response += `• Price: ${formatValue(trade.price)}\n`;
    response += `• Volume: ${formatValue(trade.volume)}\n`;
    response += `• Source: ${trade.source}\n`;
    if (trade.buyer && trade.seller) {
        response += `• Buyer: ${shortenAddress(trade.buyer)}\n`;
        response += `• Seller: ${shortenAddress(trade.seller)}\n`;
    }
    response += `• Tx: ${shortenAddress(trade.txHash)}`;

    return response;
};

const formatPairTradesResponse = (
    data: PairTradesResponse,
    chain: Chain
): string => {
    const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);

    let response = `Recent Trades for ${data.pair.baseToken}/${data.pair.quoteToken} pair on ${chainName}\n\n`;

    if (data.trades.length === 0) {
        return response + "No trades found.";
    }

    // Calculate summary statistics
    const totalVolume = data.trades.reduce((sum, t) => sum + t.volume, 0);
    const averageVolume = totalVolume / data.trades.length;
    const buyCount = data.trades.filter((t) => t.side === "buy").length;
    const buyRatio = (buyCount / data.trades.length) * 100;
    const averagePrice =
        data.trades.reduce((sum, t) => sum + t.price, 0) / data.trades.length;
    const priceChange =
        ((data.trades[data.trades.length - 1].price - data.trades[0].price) /
            data.trades[0].price) *
        100;
    const highestPrice = Math.max(...data.trades.map((t) => t.price));
    const lowestPrice = Math.min(...data.trades.map((t) => t.price));
    const priceRange = ((highestPrice - lowestPrice) / lowestPrice) * 100;

    response += `📊 Summary\n`;
    response += `• Total Trades: ${data.trades.length}\n`;
    response += `• Total Volume: ${formatValue(totalVolume)}\n`;
    response += `• Average Volume: ${formatValue(averageVolume)}\n`;
    response += `• Buy/Sell Ratio: ${buyRatio.toFixed(1)}% buys\n`;
    response += `• Average Price: ${formatValue(averagePrice)}\n`;
    response += `• Price Change: ${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(2)}%\n`;
    response += `• Price Range: ${priceRange.toFixed(2)}%\n\n`;

    // Add market analysis
    const volatility = priceRange / Math.sqrt(data.trades.length);
    const volumePerTrade = totalVolume / data.trades.length;
    let marketAnalysis = "";

    if (data.trades.length < 5) {
        marketAnalysis = "Insufficient data for detailed analysis";
    } else {
        // Analyze trading activity
        const activityLevel =
            data.trades.length > 20
                ? "high"
                : data.trades.length > 10
                  ? "moderate"
                  : "low";
        const volumeLevel =
            volumePerTrade > averageVolume * 2
                ? "high"
                : volumePerTrade > averageVolume
                  ? "moderate"
                  : "low";
        const volatilityLevel =
            volatility > 5 ? "high" : volatility > 2 ? "moderate" : "low";
        const trend =
            Math.abs(priceChange) < 1
                ? "sideways"
                : priceChange > 0
                  ? "upward"
                  : "downward";

        marketAnalysis = `Market shows ${activityLevel} trading activity with ${volumeLevel} volume per trade. `;
        marketAnalysis += `${volatilityLevel.charAt(0).toUpperCase() + volatilityLevel.slice(1)} volatility with a ${trend} price trend.`;
    }

    response += `📈 Market Analysis\n`;
    response += `• ${marketAnalysis}\n\n`;

    response += `🔄 Recent Trades\n`;
    data.trades.forEach((trade, index) => {
        response += `${index + 1}. ${formatPairTrade(trade)}\n\n`;
    });

    if (data.totalCount > data.trades.length) {
        response += `Showing ${data.trades.length} of ${data.totalCount} total trades.`;
    }

    return response;
};

export const pairTradesProvider: Provider = {
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

        if (!containsPairTradesKeyword(messageText)) {
            return null;
        }

        const addresses = extractContractAddresses(messageText);
        if (addresses.length !== 2) {
            return null;
        }

        const chain = extractChain(messageText);
        const limit = extractLimit(messageText);

        elizaLogger.info(
            `PAIR TRADES provider activated for base ${addresses[0]} and quote ${addresses[1]} on ${chain}`
        );

        const tradesData = await getPairTrades(
            apiKey,
            addresses[0],
            addresses[1],
            chain,
            limit
        );

        if (!tradesData) {
            return null;
        }

        return formatPairTradesResponse(tradesData, chain);
    },
};
