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
    Timeframe,
    extractChain,
    extractContractAddresses,
    extractLimit,
    extractTimeRange,
    extractTimeframe,
    formatTimestamp,
    formatValue,
    makeApiRequest,
} from "../utils";

// Types
interface OHLCVData {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

interface PairOHLCVResponse {
    data: OHLCVData[];
    pair: {
        baseToken: string;
        quoteToken: string;
    };
}

// Constants
const PAIR_OHLCV_KEYWORDS = [
    "pair ohlcv",
    "pair candlestick",
    "pair candles",
    "pair chart",
    "pair price history",
    "pair historical data",
    "pair market data",
    "pair trading data",
    "trading chart",
    "price chart",
    "market chart",
    "candlestick chart",
    "price action",
    "market action",
    "price movement",
    "market movement",
] as const;

// Helper functions
const containsPairOHLCVKeyword = (text: string): boolean => {
    return PAIR_OHLCV_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const getPairOHLCV = async (
    apiKey: string,
    baseAddress: string,
    quoteAddress: string,
    timeframe: Timeframe,
    chain: Chain,
    limit: number
): Promise<PairOHLCVResponse | null> => {
    try {
        const params = new URLSearchParams({
            base_address: baseAddress,
            quote_address: quoteAddress,
            timeframe,
            limit: limit.toString(),
        });
        const url = `${BASE_URL}/defi/ohlcv_pair?${params.toString()}`;

        elizaLogger.info(
            `Fetching OHLCV data for pair ${baseAddress}/${quoteAddress} with ${timeframe} timeframe on ${chain} from:`,
            url
        );

        return await makeApiRequest<PairOHLCVResponse>(url, { apiKey, chain });
    } catch (error) {
        if (error instanceof Error) {
            elizaLogger.error("Error fetching pair OHLCV data:", error.message);
        }
        return null;
    }
};

const formatOHLCVData = (data: OHLCVData): string => {
    const timestamp = formatTimestamp(data.timestamp);
    const change = ((data.close - data.open) / data.open) * 100;
    const trend = change >= 0 ? "🟢" : "🔴";

    let response = `${trend} ${timestamp}\n`;
    response += `• Open: ${formatValue(data.open)}\n`;
    response += `• High: ${formatValue(data.high)}\n`;
    response += `• Low: ${formatValue(data.low)}\n`;
    response += `• Close: ${formatValue(data.close)}\n`;
    response += `• Volume: ${formatValue(data.volume)}\n`;
    response += `• Change: ${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;

    return response;
};

const formatPairOHLCVResponse = (
    data: PairOHLCVResponse,
    timeframe: Timeframe,
    chain: Chain,
    timeRange: { start: number; end: number }
): string => {
    const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);
    const startDate = formatTimestamp(timeRange.start);
    const endDate = formatTimestamp(timeRange.end);

    let response = `OHLCV Data for ${data.pair.baseToken}/${data.pair.quoteToken} pair on ${chainName}\n`;
    response += `Timeframe: ${timeframe} (${startDate} to ${endDate})\n\n`;

    if (data.data.length === 0) {
        return response + "No OHLCV data found for this pair.";
    }

    // Calculate summary statistics
    const latestPrice = data.data[data.data.length - 1].close;
    const earliestPrice = data.data[0].open;
    const priceChange = ((latestPrice - earliestPrice) / earliestPrice) * 100;
    const totalVolume = data.data.reduce((sum, d) => sum + d.volume, 0);
    const highestPrice = Math.max(...data.data.map((d) => d.high));
    const lowestPrice = Math.min(...data.data.map((d) => d.low));
    const averageVolume = totalVolume / data.data.length;

    response += `📊 Summary\n`;
    response += `• Current Price: ${formatValue(latestPrice)}\n`;
    response += `• Period Change: ${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(2)}%\n`;
    response += `• Total Volume: ${formatValue(totalVolume)}\n`;
    response += `• Average Volume: ${formatValue(averageVolume)}\n`;
    response += `• Highest Price: ${formatValue(highestPrice)}\n`;
    response += `• Lowest Price: ${formatValue(lowestPrice)}\n`;
    response += `• Price Range: ${(((highestPrice - lowestPrice) / lowestPrice) * 100).toFixed(2)}%\n\n`;

    response += `📈 Recent Data\n`;
    // Show only the last 5 entries
    const recentData = data.data.slice(-5);
    recentData.forEach((candle, index) => {
        response += `${index + 1}. ${formatOHLCVData(candle)}\n\n`;
    });

    if (data.data.length > 5) {
        response += `Showing last 5 of ${data.data.length} candles.`;
    }

    return response;
};

export const pairOHLCVProvider: Provider = {
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

        if (!containsPairOHLCVKeyword(messageText)) {
            return null;
        }

        const addresses = extractContractAddresses(messageText);
        if (addresses.length !== 2) {
            return null;
        }

        const chain = extractChain(messageText);
        const timeframe = extractTimeframe(messageText);
        const timeRange = extractTimeRange(messageText);
        const limit = extractLimit(messageText);

        elizaLogger.info(
            `PAIR OHLCV provider activated for base ${addresses[0]} and quote ${addresses[1]} with ${timeframe} timeframe on ${chain}`
        );

        const ohlcvData = await getPairOHLCV(
            apiKey,
            addresses[0],
            addresses[1],
            timeframe,
            chain,
            limit
        );

        if (!ohlcvData) {
            return null;
        }

        return formatPairOHLCVResponse(ohlcvData, timeframe, chain, timeRange);
    },
};
