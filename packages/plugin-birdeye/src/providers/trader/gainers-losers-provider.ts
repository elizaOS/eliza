import {
    IAgentRuntime,
    Memory,
    Provider,
    State,
    elizaLogger,
} from "@elizaos/core";

// Types
interface TokenMarketData {
    address: string;
    symbol: string;
    name: string;
    price: number;
    priceChange24h: number;
    priceChange24hPercent: number;
    volume24h: number;
    marketCap: number;
    liquidity: number;
    logoURI?: string;
}

interface GainersLosersData {
    gainers: TokenMarketData[];
    losers: TokenMarketData[];
    timestamp: number;
}

// Constants
const GAINERS_KEYWORDS = [
    "gainers",
    "top gainers",
    "best performing",
    "biggest gains",
    "movers up",
    "green",
    "pumping",
    "rising",
] as const;

const LOSERS_KEYWORDS = [
    "losers",
    "top losers",
    "worst performing",
    "biggest losses",
    "movers down",
    "red",
    "dumping",
    "falling",
] as const;

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
const containsGainersKeyword = (text: string): boolean => {
    return GAINERS_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const containsLosersKeyword = (text: string): boolean => {
    return LOSERS_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const extractChain = (text: string): string => {
    const chain = CHAIN_KEYWORDS.find((chain) =>
        text.toLowerCase().includes(chain.toLowerCase())
    );
    return chain || "solana";
};

const getGainersLosers = async (
    apiKey: string,
    chain: string = "solana"
): Promise<GainersLosersData | null> => {
    try {
        const params = new URLSearchParams({
            limit: "10", // Get top 10 gainers and losers
        });
        const url = `${BASE_URL}/trader/gainers-losers?${params.toString()}`;

        elizaLogger.info(`Fetching gainers/losers on ${chain} from:`, url);

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
        elizaLogger.error("Error fetching gainers/losers:", error);
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

const formatTokenData = (token: TokenMarketData): string => {
    const priceFormatted =
        token.price < 0.01
            ? token.price.toExponential(2)
            : token.price.toFixed(2);

    return (
        `• ${token.symbol} (${token.name})\n` +
        `  Price: $${priceFormatted}\n` +
        `  24h Change: ${token.priceChange24hPercent.toFixed(2)}% (${formatValue(token.priceChange24h)})\n` +
        `  Volume: ${formatValue(token.volume24h)}\n` +
        `  Market Cap: ${formatValue(token.marketCap)}\n` +
        `  Liquidity: ${formatValue(token.liquidity)}`
    );
};

const formatGainersLosersResponse = (
    data: GainersLosersData,
    chain: string,
    showGainers: boolean,
    showLosers: boolean
): string => {
    const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);
    let response = `Market Movers on ${chainName}\n`;
    response += `Last Updated: ${new Date(data.timestamp * 1000).toLocaleString()}\n\n`;

    if (showGainers && Array.isArray(data.gainers) && data.gainers.length > 0) {
        response += `📈 Top Gainers:\n`;
        data.gainers.forEach((token, index) => {
            response += `\n${index + 1}. ${formatTokenData(token)}\n`;
        });
    }

    if (showLosers && Array.isArray(data.losers) && data.losers.length > 0) {
        if (
            showGainers &&
            Array.isArray(data.gainers) &&
            data.gainers.length > 0
        )
            response += "\n";
        response += `📉 Top Losers:\n`;
        data.losers.forEach((token, index) => {
            response += `\n${index + 1}. ${formatTokenData(token)}\n`;
        });
    }

    if (
        (!data.gainers?.length && !data.losers?.length) ||
        (showGainers && !data.gainers?.length && !showLosers) ||
        (showLosers && !data.losers?.length && !showGainers)
    ) {
        response += "No market data available at this time.";
    }

    return response;
};

export const gainersLosersProvider: Provider = {
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
        const showGainers = containsGainersKeyword(messageText);
        const showLosers = containsLosersKeyword(messageText);

        // If neither gainers nor losers are specifically mentioned, show both
        const showBoth = !showGainers && !showLosers;

        if (!showGainers && !showLosers && !showBoth) {
            return null;
        }

        const chain = extractChain(messageText);

        elizaLogger.info(`GAINERS/LOSERS provider activated for ${chain}`);

        const marketData = await getGainersLosers(apiKey, chain);

        if (!marketData) {
            return null;
        }

        return formatGainersLosersResponse(
            marketData,
            chain,
            showGainers || showBoth,
            showLosers || showBoth
        );
    },
};
