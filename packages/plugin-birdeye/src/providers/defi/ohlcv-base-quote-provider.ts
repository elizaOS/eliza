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

interface BaseQuoteOHLCVResponse {
    data: OHLCVData[];
    pair: {
        baseToken: string;
        quoteToken: string;
    };
}

// Constants
const BASE_QUOTE_OHLCV_KEYWORDS = [
    "base quote ohlcv",
    "base quote candlestick",
    "base quote candles",
    "base quote chart",
    "base quote price history",
    "base quote historical data",
    "base quote market data",
    "base quote trading data",
    "base/quote chart",
    "base/quote price",
    "base/quote history",
    "base/quote movement",
    "token pair chart",
    "token pair price",
    "token pair history",
    "token pair movement",
] as const;

// Helper functions
const containsBaseQuoteOHLCVKeyword = (text: string): boolean => {
    return BASE_QUOTE_OHLCV_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const getBaseQuoteOHLCV = async (
    apiKey: string,
    baseAddress: string,
    quoteAddress: string,
    timeframe: Timeframe,
    chain: Chain,
    limit: number
): Promise<BaseQuoteOHLCVResponse | null> => {
    try {
        const params = new URLSearchParams({
            base_address: baseAddress,
            quote_address: quoteAddress,
            timeframe,
            limit: limit.toString(),
        });
        const url = `${BASE_URL}/defi/ohlcv_base_quote?${params.toString()}`;

        elizaLogger.info(
            `Fetching base/quote OHLCV data for ${baseAddress}/${quoteAddress} with ${timeframe} timeframe on ${chain} from:`,
            url
        );

        return await makeApiRequest<BaseQuoteOHLCVResponse>(url, {
            apiKey,
            chain,
        });
    } catch (error) {
        if (error instanceof Error) {
            elizaLogger.error(
                "Error fetching base/quote OHLCV data:",
                error.message
            );
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

const formatBaseQuoteOHLCVResponse = (
    data: BaseQuoteOHLCVResponse,
    timeframe: Timeframe,
    chain: Chain,
    timeRange: { start: number; end: number }
): string => {
    const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);
    const startDate = formatTimestamp(timeRange.start);
    const endDate = formatTimestamp(timeRange.end);

    let response = `Base/Quote OHLCV Data for ${data.pair.baseToken}/${data.pair.quoteToken} on ${chainName}\n`;
    response += `Timeframe: ${timeframe} (${startDate} to ${endDate})\n\n`;

    if (data.data.length === 0) {
        return response + "No OHLCV data found for this base/quote pair.";
    }

    // Calculate summary statistics
    const latestPrice = data.data[data.data.length - 1].close;
    const earliestPrice = data.data[0].open;
    const priceChange = ((latestPrice - earliestPrice) / earliestPrice) * 100;
    const totalVolume = data.data.reduce((sum, d) => sum + d.volume, 0);
    const highestPrice = Math.max(...data.data.map((d) => d.high));
    const lowestPrice = Math.min(...data.data.map((d) => d.low));
    const averageVolume = totalVolume / data.data.length;
    const volatility = ((highestPrice - lowestPrice) / lowestPrice) * 100;

    response += `📊 Summary\n`;
    response += `• Current Price: ${formatValue(latestPrice)}\n`;
    response += `• Period Change: ${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(2)}%\n`;
    response += `• Total Volume: ${formatValue(totalVolume)}\n`;
    response += `• Average Volume: ${formatValue(averageVolume)}\n`;
    response += `• Highest Price: ${formatValue(highestPrice)}\n`;
    response += `• Lowest Price: ${formatValue(lowestPrice)}\n`;
    response += `• Volatility: ${volatility.toFixed(2)}%\n\n`;

    // Add trend analysis
    const trendStrength = Math.abs(priceChange);
    let trendAnalysis = "";
    if (trendStrength < 1) {
        trendAnalysis = "Sideways movement with low volatility";
    } else if (trendStrength < 5) {
        trendAnalysis =
            priceChange > 0 ? "Slight upward trend" : "Slight downward trend";
    } else if (trendStrength < 10) {
        trendAnalysis =
            priceChange > 0
                ? "Moderate upward trend"
                : "Moderate downward trend";
    } else {
        trendAnalysis =
            priceChange > 0 ? "Strong upward trend" : "Strong downward trend";
    }

    response += `📈 Trend Analysis\n`;
    response += `• ${trendAnalysis}\n`;
    response += `• Volatility is ${volatility < 5 ? "low" : volatility < 15 ? "moderate" : "high"}\n\n`;

    response += `📊 Recent Data\n`;
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

export const baseQuoteOHLCVProvider: Provider = {
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

        if (!containsBaseQuoteOHLCVKeyword(messageText)) {
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
            `BASE/QUOTE OHLCV provider activated for base ${addresses[0]} and quote ${addresses[1]} with ${timeframe} timeframe on ${chain}`
        );

        const ohlcvData = await getBaseQuoteOHLCV(
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

        return formatBaseQuoteOHLCVResponse(
            ohlcvData,
            timeframe,
            chain,
            timeRange
        );
    },
};
