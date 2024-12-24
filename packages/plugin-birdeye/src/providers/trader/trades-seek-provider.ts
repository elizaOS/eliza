import {
    IAgentRuntime,
    Memory,
    Provider,
    State,
    elizaLogger,
} from "@elizaos/core";

// Types
interface Trade {
    timestamp: number;
    token: string;
    tokenAddress: string;
    price: number;
    volume: number;
    side: "buy" | "sell";
    source: string;
    txHash: string;
    buyer?: string;
    seller?: string;
}

interface TradesResponse {
    trades: Trade[];
    totalCount: number;
}

// Constants
const TIME_SEEK_KEYWORDS = [
    "trades since",
    "trades after",
    "trades before",
    "trades from",
    "trades at",
    "trading since",
    "trading after",
    "trading before",
    "trading from",
    "trading at",
    "transactions since",
    "transactions after",
    "transactions before",
    "transactions from",
    "transactions at",
] as const;

const TIME_UNITS = {
    second: 1,
    minute: 60,
    hour: 3600,
    day: 86400,
    week: 604800,
    month: 2592000,
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
const containsTimeSeekKeyword = (text: string): boolean => {
    return TIME_SEEK_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const extractChain = (text: string): string => {
    const chain = CHAIN_KEYWORDS.find((chain) =>
        text.toLowerCase().includes(chain.toLowerCase())
    );
    return chain || "solana";
};

const extractTimeFromText = (text: string): number | null => {
    // Try to find time expressions like "1 hour ago", "2 days ago", etc.
    const timeRegex = /(\d+)\s*(second|minute|hour|day|week|month)s?\s*ago/i;
    const match = text.match(timeRegex);

    if (match) {
        const amount = parseInt(match[1]);
        const unit = match[2].toLowerCase() as keyof typeof TIME_UNITS;
        const now = Math.floor(Date.now() / 1000);
        return now - amount * TIME_UNITS[unit];
    }

    // Try to find specific date/time
    const dateMatch = text.match(/(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})/);
    if (dateMatch) {
        const date = new Date(dateMatch[1]);
        if (!isNaN(date.getTime())) {
            return Math.floor(date.getTime() / 1000);
        }
    }

    return null;
};

const getTradesByTime = async (
    apiKey: string,
    timestamp: number,
    chain: string = "solana",
    limit: number = 10
): Promise<TradesResponse | null> => {
    try {
        const params = new URLSearchParams({
            timestamp: timestamp.toString(),
            limit: limit.toString(),
        });
        const url = `${BASE_URL}/trader/trades_seek_time?${params.toString()}`;

        elizaLogger.info(
            `Fetching trades since ${new Date(timestamp * 1000).toLocaleString()} on ${chain} from:`,
            url
        );

        const response = await fetch(url, {
            headers: {
                "X-API-KEY": apiKey,
                "x-chain": chain,
            },
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return data.data;
    } catch (error) {
        elizaLogger.error("Error fetching trades by time:", error);
        return null;
    }
};

const formatValue = (value: number): string => {
    if (value >= 1_000_000_000) {
        return `$${(value / 1_000_000_000).toFixed(2)}B`;
    }
    if (value >= 1_000_000) {
        return `$${(value / 1_000_000).toFixed(2)}M`;
    }
    if (value >= 1_000) {
        return `$${(value / 1_000).toFixed(2)}K`;
    }
    return `$${value.toFixed(2)}`;
};

const shortenAddress = (address: string): string => {
    if (!address || address.length <= 12) return address || "Unknown";
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

const formatTrade = (trade: Trade): string => {
    const timestamp = new Date(trade.timestamp * 1000).toLocaleString();
    const priceFormatted =
        trade.price < 0.01
            ? trade.price.toExponential(2)
            : trade.price.toFixed(2);
    const side = trade.side === "buy" ? "🟢 Buy" : "🔴 Sell";

    let response = `${side} ${trade.token} - ${timestamp}\n`;
    response += `• Token: ${shortenAddress(trade.tokenAddress)}\n`;
    response += `• Price: $${priceFormatted}\n`;
    response += `• Volume: ${formatValue(trade.volume)}\n`;
    response += `• Source: ${trade.source}\n`;
    if (trade.buyer && trade.seller) {
        response += `• Buyer: ${shortenAddress(trade.buyer)}\n`;
        response += `• Seller: ${shortenAddress(trade.seller)}\n`;
    }
    response += `• Tx: ${shortenAddress(trade.txHash)}`;

    return response;
};

const formatTradesResponse = (
    data: TradesResponse,
    timestamp: number,
    chain: string
): string => {
    const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);
    const fromTime = new Date(timestamp * 1000).toLocaleString();
    let response = `Trades on ${chainName} since ${fromTime}:\n\n`;

    if (data.trades.length === 0) {
        return response + "No trades found in this time period.";
    }

    data.trades.forEach((trade, index) => {
        response += `${index + 1}. ${formatTrade(trade)}\n\n`;
    });

    if (data.totalCount > data.trades.length) {
        response += `Showing ${data.trades.length} of ${data.totalCount} total trades.`;
    }

    return response;
};

export const tradesSeekProvider: Provider = {
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

        if (!containsTimeSeekKeyword(messageText)) {
            return null;
        }

        const timestamp = extractTimeFromText(messageText);
        if (!timestamp) {
            return null;
        }

        const chain = extractChain(messageText);

        elizaLogger.info(
            `TRADES SEEK provider activated for time ${new Date(timestamp * 1000).toLocaleString()} on ${chain}`
        );

        const tradesData = await getTradesByTime(apiKey, timestamp, chain);

        if (!tradesData) {
            return null;
        }

        return formatTradesResponse(tradesData, timestamp, chain);
    },
};
