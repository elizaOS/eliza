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
    formatPercentChange,
    formatValue,
    makeApiRequest,
} from "../utils";

// Types
interface MarketData {
    price: number;
    priceChange24h: number;
    priceChange7d: number;
    priceChange14d: number;
    priceChange30d: number;
    volume24h: number;
    volume7d: number;
    marketCap: number;
    fullyDilutedValuation: number;
    rank: number;
    liquidity: number;
    liquidityChange24h: number;
    liquidityChange7d: number;
}

interface MarketResponse {
    data: MarketData;
    token: string;
}

// Constants
const MARKET_KEYWORDS = [
    "market",
    "price",
    "volume",
    "liquidity",
    "market cap",
    "mcap",
    "fdv",
    "valuation",
    "market data",
    "market info",
    "market stats",
    "market metrics",
    "market overview",
    "market analysis",
    "price change",
    "price movement",
    "price action",
    "price performance",
] as const;

// Helper functions
const containsMarketKeyword = (text: string): boolean => {
    return MARKET_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const getTokenMarket = async (
    apiKey: string,
    contractAddress: string,
    chain: Chain
): Promise<MarketResponse | null> => {
    try {
        const params = new URLSearchParams({
            address: contractAddress,
        });
        const url = `${BASE_URL}/token/market?${params.toString()}`;

        elizaLogger.info(
            `Fetching market data for ${contractAddress} on ${chain} from:`,
            url
        );

        return await makeApiRequest<MarketResponse>(url, { apiKey, chain });
    } catch (error) {
        if (error instanceof Error) {
            elizaLogger.error("Error fetching market data:", error.message);
        }
        return null;
    }
};

const formatPriceChanges = (data: MarketData): string => {
    let changes = "";
    changes += `24h: ${formatPercentChange(data.priceChange24h)}\n`;
    changes += `7d:  ${formatPercentChange(data.priceChange7d)}\n`;
    changes += `14d: ${formatPercentChange(data.priceChange14d)}\n`;
    changes += `30d: ${formatPercentChange(data.priceChange30d)}`;
    return changes;
};

const formatLiquidityChanges = (data: MarketData): string => {
    let changes = "";
    changes += `24h: ${formatPercentChange(data.liquidityChange24h)}\n`;
    changes += `7d:  ${formatPercentChange(data.liquidityChange7d)}`;
    return changes;
};

const analyzeMarketMetrics = (data: MarketData): string => {
    let analysis = "";

    // Price trend analysis
    if (data.priceChange24h > 5) {
        analysis += "📈 Strong bullish momentum in the last 24 hours. ";
    } else if (data.priceChange24h < -5) {
        analysis += "📉 Significant price decline in the last 24 hours. ";
    }

    // Volume analysis
    const volumeToMcap = (data.volume24h / data.marketCap) * 100;
    if (volumeToMcap > 20) {
        analysis += "🔥 High trading activity relative to market cap. ";
    } else if (volumeToMcap < 1) {
        analysis += "⚠️ Low trading volume relative to market cap. ";
    }

    // Liquidity analysis
    const liquidityToMcap = (data.liquidity / data.marketCap) * 100;
    if (liquidityToMcap > 30) {
        analysis += "💧 Strong liquidity relative to market cap. ";
    } else if (liquidityToMcap < 5) {
        analysis += "⚠️ Limited liquidity relative to market cap. ";
    }

    // Market cap vs FDV analysis
    if (data.fullyDilutedValuation > data.marketCap * 3) {
        analysis += "⚠️ High potential for dilution based on FDV. ";
    }

    return analysis || "Market metrics are within normal ranges.";
};

const formatMarketResponse = (data: MarketResponse, chain: Chain): string => {
    const { data: marketData } = data;
    const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);

    let response = `Market Data for ${data.token} on ${chainName}\n\n`;

    // Market Analysis
    response += "📊 Market Analysis\n";
    response += analyzeMarketMetrics(marketData) + "\n\n";

    // Price Information
    response += "💰 Price Information\n";
    response += `Current Price: ${formatValue(marketData.price)}\n\n`;
    response += "Price Changes:\n";
    response += formatPriceChanges(marketData) + "\n\n";

    // Volume Information
    response += "📈 Volume Information\n";
    response += `24h Volume: ${marketData.volume24h ? formatValue(marketData.volume24h) : "N/A"}\n`;
    response += `7d Volume: ${marketData.volume7d ? formatValue(marketData.volume7d) : "N/A"}\n\n`;

    // Market Metrics
    response += "📊 Market Metrics\n";
    response += `Market Cap: ${marketData.marketCap ? formatValue(marketData.marketCap) : "N/A"}\n`;
    response += `Fully Diluted Valuation: ${marketData.fullyDilutedValuation ? formatValue(marketData.fullyDilutedValuation) : "N/A"}\n`;
    response += `Market Rank: ${marketData.rank ? `#${marketData.rank}` : "N/A"}\n\n`;

    // Liquidity Information
    response += "💧 Liquidity Information\n";
    response += `Current Liquidity: ${marketData.liquidity ? formatValue(marketData.liquidity) : "N/A"}\n\n`;
    response += "Liquidity Changes:\n";
    response += formatLiquidityChanges(marketData);

    return response;
};

export const tokenMarketProvider: Provider = {
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

        if (!containsMarketKeyword(messageText)) {
            return null;
        }

        const addresses = extractContractAddresses(messageText);
        if (addresses.length === 0) {
            return null;
        }

        const chain = extractChain(messageText);

        elizaLogger.info(
            `TOKEN MARKET provider activated for ${addresses[0]} on ${chain}`
        );

        const marketData = await getTokenMarket(apiKey, addresses[0], chain);

        if (!marketData) {
            return null;
        }

        return formatMarketResponse(marketData, chain);
    },
};
