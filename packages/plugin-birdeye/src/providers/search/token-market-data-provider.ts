import {
    IAgentRuntime,
    Memory,
    Provider,
    State,
    elizaLogger,
} from "@elizaos/core";

interface SearchToken {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    volume24hUSD: number;
    liquidity: number;
    logoURI: string;
    price: number;
}

const SEARCH_KEYWORDS = ["search", "find", "look for", "lookup", "locate"];

const TOKEN_KEYWORDS = [
    "token",
    "tokens",
    "coin",
    "coins",
    "crypto",
    "cryptocurrency",
    "asset",
    "assets",
    "sol",
    "solana",
];

const SUPPORTED_CHAINS = [
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
];

const BASE_URL = "https://public-api.birdeye.so";

interface SearchTokensOptions {
    query: string;
    chain?: string;
    limit?: number;
    offset?: number;
}

const searchTokens = async (
    apiKey: string,
    options: SearchTokensOptions
): Promise<SearchToken[]> => {
    try {
        const { query, chain = "solana", limit = 10, offset = 0 } = options;

        const params = new URLSearchParams({
            query,
            limit: limit.toString(),
            offset: offset.toString(),
        });

        const url = `${BASE_URL}/defi/v3/search?${params.toString()}`;
        elizaLogger.info("Searching tokens from:", url);

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
        return data.data.tokens || [];
    } catch (error) {
        elizaLogger.error("Error searching tokens:", error);
        throw error;
    }
};

const formatSearchResultsToString = (
    tokens: SearchToken[],
    query: string,
    chain: string
): string => {
    if (!tokens.length) {
        return `No tokens found matching "${query}" on ${chain}.`;
    }

    const formattedTokens = tokens
        .map((token, index) => {
            const priceFormatted =
                token.price != null
                    ? token.price < 0.01
                        ? token.price.toExponential(2)
                        : token.price.toFixed(2)
                    : "N/A";

            const volume =
                token.volume24hUSD != null
                    ? `$${(token.volume24hUSD / 1_000_000).toFixed(2)}M`
                    : "N/A";

            const liquidity =
                token.liquidity != null
                    ? `$${(token.liquidity / 1_000_000).toFixed(2)}M`
                    : "N/A";

            return (
                `${index + 1}. ${token.name} (${token.symbol}):\n` +
                `   Address: ${token.address}\n` +
                `   Price: $${priceFormatted}\n` +
                `   Volume 24h: ${volume}\n` +
                `   Liquidity: ${liquidity}`
            );
        })
        .join("\n\n");

    return `Search results for "${query}" on ${chain.charAt(0).toUpperCase() + chain.slice(1)}:\n\n${formattedTokens}`;
};

export const tokenMarketDataProvider: Provider = {
    get: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State
    ): Promise<string | null> => {
        const apiKey = runtime.getSetting("BIRDEYE_API_KEY");
        if (!apiKey) {
            return null;
        }

        const messageText = message.content.text.toLowerCase();

        // Check if message contains search-related keywords
        const hasSearchKeyword = SEARCH_KEYWORDS.some((keyword) =>
            messageText.includes(keyword)
        );

        // Check if message contains token-related keywords
        const hasTokenKeyword = TOKEN_KEYWORDS.some((keyword) =>
            messageText.includes(keyword)
        );

        // Extract potential search query
        // Look for quotes first
        let searchQuery =
            messageText.match(/"([^"]+)"/)?.[1] ||
            messageText.match(/'([^']+)'/)?.[1];

        // If no quotes, try to extract query after search keywords
        if (!searchQuery) {
            for (const keyword of SEARCH_KEYWORDS) {
                if (messageText.includes(keyword)) {
                    const parts = messageText.split(keyword);
                    if (parts[1]) {
                        searchQuery = parts[1]
                            .trim()
                            .split(/[\s,.]/)
                            .filter((word) => word.length > 1)
                            .join(" ")
                            .trim();
                        break;
                    }
                }
            }
        }

        // Determine which chain is being asked about
        const requestedChain =
            SUPPORTED_CHAINS.find((chain) =>
                messageText.includes(chain.toLowerCase())
            ) || "solana";

        // Get the current offset from state or default to 0
        const currentOffset = (_state?.searchTokensOffset as number) || 0;

        // Combine signals to make decision
        const shouldProvideData =
            searchQuery && hasSearchKeyword && hasTokenKeyword;

        if (!shouldProvideData || !searchQuery) {
            return null;
        }

        elizaLogger.info(
            `Search tokens provider activated for query "${searchQuery}" on ${requestedChain}`
        );

        const searchResults = await searchTokens(apiKey, {
            query: searchQuery,
            chain: requestedChain,
            offset: currentOffset,
            limit: 10,
        });

        return formatSearchResultsToString(
            searchResults,
            searchQuery,
            requestedChain
        );
    },
};
