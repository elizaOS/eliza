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
    formatPercentChange,
    formatValue,
    makeApiRequest,
    shortenAddress,
} from "../utils";

// Types
interface TokenListData {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    price: number;
    priceChange24h: number;
    volume24h: number;
    marketCap: number;
    liquidity: number;
    rank: number;
}

interface TokenListResponse {
    data: TokenListData[];
    totalCount: number;
}

// Constants
const LIST_KEYWORDS = [
    "list",
    "top tokens",
    "popular tokens",
    "trending tokens",
    "token list",
    "token ranking",
    "token rankings",
    "token leaderboard",
    "best tokens",
    "highest volume",
    "highest market cap",
    "highest liquidity",
] as const;

// Helper functions
const containsListKeyword = (text: string): boolean => {
    return LIST_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const getTokenList = async (
    apiKey: string,
    chain: Chain,
    limit: number = 10
): Promise<TokenListResponse | null> => {
    try {
        const params = new URLSearchParams({
            limit: limit.toString(),
        });
        const url = `${BASE_URL}/token/list?${params.toString()}`;

        elizaLogger.info(`Fetching token list on ${chain} from:`, url);

        return await makeApiRequest<TokenListResponse>(url, { apiKey, chain });
    } catch (error) {
        if (error instanceof Error) {
            elizaLogger.error("Error fetching token list:", error.message);
        }
        return null;
    }
};

const formatTokenData = (token: TokenListData, rank: number): string => {
    let response = `${rank}. ${token.name} (${token.symbol})\n`;
    response += `   • Address: ${shortenAddress(token.address)}\n`;
    response += `   • Price: ${formatValue(token.price)} (${formatPercentChange(token.priceChange24h)})\n`;
    response += `   • Volume 24h: ${formatValue(token.volume24h)}\n`;
    response += `   • Market Cap: ${formatValue(token.marketCap)}\n`;
    response += `   • Liquidity: ${formatValue(token.liquidity)}`;
    return response;
};

const analyzeTokenList = (tokens: TokenListData[]): string => {
    let analysis = "";

    // Volume analysis
    const validVolumes = tokens.filter((t) => t.volume24h != null);
    const totalVolume = validVolumes.reduce((sum, t) => sum + t.volume24h, 0);
    const avgVolume =
        validVolumes.length > 0 ? totalVolume / validVolumes.length : 0;
    const highVolumeTokens = validVolumes.filter(
        (t) => t.volume24h > avgVolume * 2
    );

    if (highVolumeTokens.length > 0) {
        analysis += `🔥 ${highVolumeTokens.length} tokens showing exceptional trading activity.\n`;
    }

    // Price movement analysis
    const validPriceChanges = tokens.filter((t) => t.priceChange24h != null);
    const positiveMovers = validPriceChanges.filter(
        (t) => t.priceChange24h > 0
    );
    const strongMovers = validPriceChanges.filter(
        (t) => Math.abs(t.priceChange24h) > 10
    );

    if (validPriceChanges.length > 0) {
        if (positiveMovers.length > validPriceChanges.length / 2) {
            analysis +=
                "📈 Market showing bullish trend with majority positive price movement.\n";
        } else {
            analysis +=
                "📉 Market showing bearish trend with majority negative price movement.\n";
        }

        if (strongMovers.length > 0) {
            analysis += `⚡ ${strongMovers.length} tokens with significant price movement (>10%).\n`;
        }
    }

    // Liquidity analysis
    const totalLiquidity = tokens.reduce((sum, t) => sum + t.liquidity, 0);
    const avgLiquidity = totalLiquidity / tokens.length;
    const highLiquidityTokens = tokens.filter(
        (t) => t.liquidity > avgLiquidity * 2
    );

    if (highLiquidityTokens.length > 0) {
        analysis += `💧 ${highLiquidityTokens.length} tokens with notably high liquidity.\n`;
    }

    return analysis;
};

const formatListResponse = (data: TokenListResponse, chain: Chain): string => {
    const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);

    let response = `Top Tokens on ${chainName}\n\n`;

    // Market Analysis
    response += "📊 Market Analysis\n";
    response += analyzeTokenList(data.data) + "\n\n";

    // Token List
    response += "🏆 Token Rankings\n";
    data.data.forEach((token, index) => {
        response += formatTokenData(token, index + 1) + "\n\n";
    });

    if (data.totalCount > data.data.length) {
        response += `Showing ${data.data.length} of ${data.totalCount} total tokens.`;
    }

    return response;
};

export const tokenListProvider: Provider = {
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

        if (!containsListKeyword(messageText)) {
            return null;
        }

        const chain = extractChain(messageText);
        const limit = messageText.toLowerCase().includes("all") ? 100 : 10;

        elizaLogger.info(`TOKEN LIST provider activated for ${chain}`);

        const listData = await getTokenList(apiKey, chain, limit);

        if (!listData) {
            return null;
        }

        return formatListResponse(listData, chain);
    },
};
