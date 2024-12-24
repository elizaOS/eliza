import {
    IAgentRuntime,
    Memory,
    Provider,
    State,
    elizaLogger,
} from "@elizaos/core";

// Types
interface OHLCVData {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

// Constants
const OHLCV_KEYWORDS = [
    "ohlc",
    "ohlcv",
    "candlestick",
    "candle",
    "chart",
    "price history",
    "historical",
] as const;

const TIME_INTERVAL_KEYWORDS = {
    "1m": ["1 minute", "1min", "1m"],
    "3m": ["3 minutes", "3min", "3m"],
    "5m": ["5 minutes", "5min", "5m"],
    "15m": ["15 minutes", "15min", "15m"],
    "30m": ["30 minutes", "30min", "30m"],
    "1h": ["1 hour", "1hr", "1h"],
    "2h": ["2 hours", "2hr", "2h"],
    "4h": ["4 hours", "4hr", "4h"],
    "6h": ["6 hours", "6hr", "6h"],
    "12h": ["12 hours", "12hr", "12h"],
    "1d": ["1 day", "daily", "1d"],
    "1w": ["1 week", "weekly", "1w"],
    "1mo": ["1 month", "monthly", "1mo"],
} as const;

const CHAIN_KEYWORDS = [
    "solana",
    "ethereum",
    "arbitrum",
    "avalanche",
    "bsc",
    "optimism",
    "polygon",
    "base",
    "zksync",
    "sui",
] as const;

const BASE_URL = "https://public-api.birdeye.so";

// Helper functions
const containsOHLCVKeyword = (text: string): boolean => {
    return OHLCV_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const extractTimeInterval = (text: string): string => {
    const lowerText = text.toLowerCase();
    for (const [interval, keywords] of Object.entries(TIME_INTERVAL_KEYWORDS)) {
        if (keywords.some((keyword) => lowerText.includes(keyword))) {
            return interval;
        }
    }
    return "1d"; // Default to daily if no interval specified
};

const extractChain = (text: string): string => {
    const chain = CHAIN_KEYWORDS.find((chain) =>
        text.toLowerCase().includes(chain.toLowerCase())
    );
    return chain || "solana";
};

const extractContractAddress = (text: string): string | null => {
    const words = text.split(/\s+/);

    for (const word of words) {
        // Ethereum-like addresses (0x...)
        if (/^0x[a-fA-F0-9]{40}$/i.test(word)) {
            return word;
        }
        // Solana addresses (base58, typically 32-44 chars)
        if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(word)) {
            return word;
        }
    }
    return null;
};

const getOHLCVData = async (
    apiKey: string,
    contractAddress: string,
    interval: string = "1d",
    chain: string = "solana"
): Promise<OHLCVData[] | null> => {
    try {
        const params = new URLSearchParams({
            address: contractAddress,
            interval,
            limit: "24", // Get last 24 periods
        });
        const url = `${BASE_URL}/defi/ohlcv?${params.toString()}`;

        elizaLogger.info(
            `Fetching OHLCV data for address ${contractAddress} on ${chain} with interval ${interval} from:`,
            url
        );

        const response = await fetch(url, {
            headers: {
                "X-API-KEY": apiKey,
                "x-chain": chain,
            },
        });

        if (!response.ok) {
            if (response.status === 404) {
                elizaLogger.warn(
                    `Token not found: ${contractAddress} on ${chain}`
                );
                return null;
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return data.data;
    } catch (error) {
        elizaLogger.error("Error fetching OHLCV data:", error);
        return null;
    }
};

const formatNumber = (num: number): string => {
    if (!num && num !== 0) return "N/A";
    return num < 0.01
        ? num.toExponential(2)
        : num.toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 6,
          });
};

const formatVolume = (volume: number): string => {
    if (volume >= 1_000_000_000) {
        return `$${(volume / 1_000_000_000).toFixed(2)}B`;
    }
    if (volume >= 1_000_000) {
        return `$${(volume / 1_000_000).toFixed(2)}M`;
    }
    if (volume >= 1_000) {
        return `$${(volume / 1_000).toFixed(2)}K`;
    }
    return `$${volume.toFixed(2)}`;
};

const formatOHLCVResponse = (
    data: OHLCVData[],
    interval: string,
    chain: string
): string => {
    if (data.length === 0) {
        return "No OHLCV data available for the specified period.";
    }

    // Sort data by timestamp in ascending order
    const sortedData = [...data].sort((a, b) => a.timestamp - b.timestamp);
    const latestData = sortedData[sortedData.length - 1];

    let response = `OHLCV Data (${interval}) on ${chain.charAt(0).toUpperCase() + chain.slice(1)}:\n\n`;

    // Latest price information
    response += `📊 Latest Candle (${new Date(latestData.timestamp * 1000).toLocaleString()})\n`;
    response += `• Open: $${formatNumber(latestData.open)}\n`;
    response += `• High: $${formatNumber(latestData.high)}\n`;
    response += `• Low: $${formatNumber(latestData.low)}\n`;
    response += `• Close: $${formatNumber(latestData.close)}\n`;
    response += `• Volume: ${formatVolume(latestData.volume)}\n`;

    // Price change statistics
    const priceChange = latestData.close - latestData.open;
    const priceChangePercent = (priceChange / latestData.open) * 100;
    const trend = priceChange >= 0 ? "📈" : "📉";

    response += `\n${trend} Period Change\n`;
    response += `• Price Change: $${formatNumber(priceChange)} (${priceChangePercent.toFixed(2)}%)\n`;

    // Volume analysis
    const totalVolume = sortedData.reduce(
        (sum, candle) => sum + candle.volume,
        0
    );
    const avgVolume = totalVolume / sortedData.length;

    response += `\n📊 Volume Analysis\n`;
    response += `• Total Volume: ${formatVolume(totalVolume)}\n`;
    response += `• Average Volume: ${formatVolume(avgVolume)}\n`;

    return response;
};

export const ohlcvProvider: Provider = {
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

        if (!containsOHLCVKeyword(messageText)) {
            return null;
        }

        const contractAddress = extractContractAddress(messageText);
        if (!contractAddress) {
            return null;
        }

        const chain = extractChain(messageText);
        const interval = extractTimeInterval(messageText);

        elizaLogger.info(
            `OHLCV provider activated for address ${contractAddress} on ${chain} with interval ${interval}`
        );

        const ohlcvData = await getOHLCVData(
            apiKey,
            contractAddress,
            interval,
            chain
        );

        if (!ohlcvData) {
            return null;
        }

        return formatOHLCVResponse(ohlcvData, interval, chain);
    },
};
