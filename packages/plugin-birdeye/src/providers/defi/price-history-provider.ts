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
    extractTimeRange,
    formatTimestamp,
    formatValue,
    makeApiRequest,
} from "../utils";

// Types
interface PriceHistoryData {
    price: number;
    timestamp: number;
    volume?: number;
}

interface PriceHistoryResponse {
    data: PriceHistoryData[];
    token: string;
}

// Constants
const PRICE_HISTORY_KEYWORDS = [
    "price history",
    "historical price",
    "price chart",
    "price trend",
    "price movement",
    "price changes",
    "price over time",
    "price timeline",
    "price performance",
    "price data",
    "historical data",
    "price analysis",
    "price tracking",
    "price evolution",
] as const;

// Helper functions
const containsPriceHistoryKeyword = (text: string): boolean => {
    return PRICE_HISTORY_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const getPriceHistory = async (
    apiKey: string,
    contractAddress: string,
    startTime: number,
    endTime: number,
    chain: Chain
): Promise<PriceHistoryResponse | null> => {
    try {
        const params = new URLSearchParams({
            address: contractAddress,
            time_from: startTime.toString(),
            time_to: endTime.toString(),
        });
        const url = `${BASE_URL}/defi/price_history_unix?${params.toString()}`;

        elizaLogger.info(
            `Fetching price history for token ${contractAddress} from ${new Date(
                startTime * 1000
            ).toLocaleString()} to ${new Date(
                endTime * 1000
            ).toLocaleString()} on ${chain} from:`,
            url
        );

        return await makeApiRequest<PriceHistoryResponse>(url, {
            apiKey,
            chain,
        });
    } catch (error) {
        if (error instanceof Error) {
            elizaLogger.error("Error fetching price history:", error.message);
        }
        return null;
    }
};

const formatPriceHistoryResponse = (
    data: PriceHistoryResponse,
    timeRange: { start: number; end: number },
    chain: Chain
): string => {
    const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);
    const startDate = formatTimestamp(timeRange.start);
    const endDate = formatTimestamp(timeRange.end);

    let response = `Price History for ${data.token} on ${chainName}\n`;
    response += `Period: ${startDate} to ${endDate}\n\n`;

    if (data.data.length === 0) {
        return response + "No price data found for this period.";
    }

    // Calculate summary statistics
    const prices = data.data.map((d) => d.price);
    const volumes = data.data.map((d) => d.volume || 0);
    const startPrice = data.data[0].price;
    const endPrice = data.data[data.data.length - 1].price;
    const priceChange = ((endPrice - startPrice) / startPrice) * 100;
    const highestPrice = Math.max(...prices);
    const lowestPrice = Math.min(...prices);
    const averagePrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    const totalVolume = volumes.reduce((a, b) => a + b, 0);
    const volatility = ((highestPrice - lowestPrice) / averagePrice) * 100;

    response += `📊 Summary\n`;
    response += `• Start Price: ${formatValue(startPrice)}\n`;
    response += `• End Price: ${formatValue(endPrice)}\n`;
    response += `• Price Change: ${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(2)}%\n`;
    response += `• Highest Price: ${formatValue(highestPrice)}\n`;
    response += `• Lowest Price: ${formatValue(lowestPrice)}\n`;
    response += `• Average Price: ${formatValue(averagePrice)}\n`;
    if (totalVolume > 0) {
        response += `• Total Volume: ${formatValue(totalVolume)}\n`;
    }
    response += `• Volatility: ${volatility.toFixed(2)}%\n\n`;

    // Add trend analysis
    const trendStrength = Math.abs(priceChange);
    let trendAnalysis = "";
    if (trendStrength < 1) {
        trendAnalysis = "Price has remained relatively stable";
    } else if (trendStrength < 5) {
        trendAnalysis =
            priceChange > 0
                ? "Price shows slight upward movement"
                : "Price shows slight downward movement";
    } else if (trendStrength < 10) {
        trendAnalysis =
            priceChange > 0
                ? "Price demonstrates moderate upward trend"
                : "Price demonstrates moderate downward trend";
    } else {
        trendAnalysis =
            priceChange > 0
                ? "Price exhibits strong upward momentum"
                : "Price exhibits strong downward momentum";
    }

    response += `📈 Trend Analysis\n`;
    response += `• ${trendAnalysis}\n`;
    response += `• Volatility is ${volatility < 10 ? "low" : volatility < 25 ? "moderate" : "high"}\n\n`;

    // Show key price points
    response += `🔑 Key Price Points\n`;
    const keyPoints = [
        { label: "Start", ...data.data[0] },
        {
            label: "High",
            price: highestPrice,
            timestamp: data.data[prices.indexOf(highestPrice)].timestamp,
        },
        {
            label: "Low",
            price: lowestPrice,
            timestamp: data.data[prices.indexOf(lowestPrice)].timestamp,
        },
        { label: "End", ...data.data[data.data.length - 1] },
    ];

    keyPoints.forEach((point) => {
        response += `• ${point.label}: ${formatValue(point.price)} (${formatTimestamp(point.timestamp)})\n`;
    });

    return response;
};

export const priceHistoryProvider: Provider = {
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

        if (!containsPriceHistoryKeyword(messageText)) {
            return null;
        }

        const addresses = extractContractAddresses(messageText);
        if (addresses.length === 0) {
            return null;
        }

        const chain = extractChain(messageText);
        const timeRange = extractTimeRange(messageText);

        elizaLogger.info(
            `PRICE HISTORY provider activated for token ${addresses[0]} from ${new Date(
                timeRange.start * 1000
            ).toLocaleString()} to ${new Date(
                timeRange.end * 1000
            ).toLocaleString()} on ${chain}`
        );

        const priceData = await getPriceHistory(
            apiKey,
            addresses[0],
            timeRange.start,
            timeRange.end,
            chain
        );

        if (!priceData) {
            return null;
        }

        return formatPriceHistoryResponse(priceData, timeRange, chain);
    },
};
