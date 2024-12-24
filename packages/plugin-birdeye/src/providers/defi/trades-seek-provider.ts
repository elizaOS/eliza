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
    extractTimeRange,
    formatTimestamp,
    formatValue,
    makeApiRequest,
    shortenAddress,
} from "../utils";

// Types
interface Trade {
    timestamp: number;
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
    token: string;
}

// Constants
const TOKEN_TRADE_KEYWORDS = [
    "token trades",
    "token trading",
    "token transactions",
    "token swaps",
    "token buys",
    "token sells",
    "token orders",
    "token executions",
    "token trade history",
    "token trading history",
    "token recent trades",
    "token market activity",
    "token trading activity",
    "token market trades",
    "token exchange history",
] as const;

// Helper functions
const containsTokenTradeKeyword = (text: string): boolean => {
    return TOKEN_TRADE_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const getTradesByTime = async (
    apiKey: string,
    contractAddress: string,
    timestamp: number,
    chain: Chain,
    limit: number
): Promise<TradesResponse | null> => {
    try {
        const params = new URLSearchParams({
            address: contractAddress,
            timestamp: timestamp.toString(),
            limit: limit.toString(),
        });
        const url = `${BASE_URL}/defi/trades_token_seek_time?${params.toString()}`;

        elizaLogger.info(
            `Fetching trades for token ${contractAddress} since ${new Date(
                timestamp * 1000
            ).toLocaleString()} on ${chain} from:`,
            url
        );

        return await makeApiRequest<TradesResponse>(url, { apiKey, chain });
    } catch (error) {
        if (error instanceof Error) {
            elizaLogger.error("Error fetching trades by time:", error.message);
        }
        return null;
    }
};

const formatTrade = (trade: Trade): string => {
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

const formatTradesResponse = (
    data: TradesResponse,
    timeRange: { start: number; end: number },
    chain: Chain
): string => {
    const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);
    const startDate = formatTimestamp(timeRange.start);
    const endDate = formatTimestamp(timeRange.end);

    let response = `Trade History for ${data.token} on ${chainName}\n`;
    response += `Period: ${startDate} to ${endDate}\n\n`;

    if (data.trades.length === 0) {
        return response + "No trades found in this time period.";
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

    response += `📊 Summary\n`;
    response += `• Total Trades: ${data.trades.length}\n`;
    response += `• Total Volume: ${formatValue(totalVolume)}\n`;
    response += `• Average Volume: ${formatValue(averageVolume)}\n`;
    response += `• Buy/Sell Ratio: ${buyRatio.toFixed(1)}% buys\n`;
    response += `• Average Price: ${formatValue(averagePrice)}\n`;
    response += `• Price Change: ${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(2)}%\n\n`;

    response += `📈 Recent Trades\n`;
    data.trades.forEach((trade, index) => {
        response += `${index + 1}. ${formatTrade(trade)}\n\n`;
    });

    if (data.totalCount > data.trades.length) {
        response += `Showing ${data.trades.length} of ${data.totalCount} total trades.`;
    }

    return response;
};

export const tokenTradesSeekProvider: Provider = {
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

        if (!containsTokenTradeKeyword(messageText)) {
            return null;
        }

        const addresses = extractContractAddresses(messageText);
        if (addresses.length === 0) {
            return null;
        }

        const chain = extractChain(messageText);
        const timeRange = extractTimeRange(messageText);
        const limit = extractLimit(messageText);

        elizaLogger.info(
            `TOKEN TRADES SEEK provider activated for token ${addresses[0]} from ${new Date(
                timeRange.start * 1000
            ).toLocaleString()} to ${new Date(
                timeRange.end * 1000
            ).toLocaleString()} on ${chain}`
        );

        const tradesData = await getTradesByTime(
            apiKey,
            addresses[0],
            timeRange.start,
            chain,
            limit
        );

        if (!tradesData) {
            return null;
        }

        return formatTradesResponse(tradesData, timeRange, chain);
    },
};
