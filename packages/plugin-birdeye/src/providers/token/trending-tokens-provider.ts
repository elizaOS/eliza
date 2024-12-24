import {
    IAgentRuntime,
    Memory,
    Provider,
    State,
    elizaLogger,
} from "@elizaos/core";

interface TrendingToken {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    volume24hUSD: number;
    liquidity: number;
    logoURI: string;
    price: number;
}

const TRENDING_KEYWORDS = [
    "trending",
    "popular",
    "hot",
    "top",
    "performing",
    "movers",
    "gainers",
    "volume",
    "liquidity",
    "market cap",
    "price action",
];

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

const ASCENDING_KEYWORDS = [
    "lowest",
    "worst",
    "bottom",
    "least",
    "smallest",
    "weakest",
];

const PAGINATION_KEYWORDS = [
    "more",
    "additional",
    "next",
    "other",
    "show more",
    "continue",
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

interface GetTrendingTokensOptions {
    sort_by?: "volume24hUSD" | "rank" | "liquidity";
    sort_type?: "desc" | "asc";
    offset?: number;
    limit?: number;
    min_liquidity?: number;
    chain?: string;
}

const getTrendingTokens = async (
    apiKey: string,
    options: GetTrendingTokensOptions = {}
): Promise<TrendingToken[]> => {
    try {
        const {
            sort_by = "volume24hUSD",
            sort_type = "desc",
            offset = 0,
            limit = 10,
            min_liquidity = 1000,
            chain = "solana",
        } = options;

        const params = new URLSearchParams({
            sort_by,
            sort_type,
            offset: offset.toString(),
            limit: limit.toString(),
            min_liquidity: min_liquidity.toString(),
        });

        const url = `${BASE_URL}/defi/token_trending?${params.toString()}`;
        elizaLogger.info("Fetching trending tokens from:", url);

        const response = await fetch(url, {
            headers: {
                "X-API-KEY": apiKey,
                "x-chain": chain,
            },
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        return (await response.json()).data.tokens;
    } catch (error) {
        elizaLogger.error("Error fetching trending tokens:", error);
        throw error;
    }
};

const formatTrendingTokensToString = (
    tokens: TrendingToken[],
    chain: string
): string => {
    if (!tokens.length) {
        return "No trending tokens found.";
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
                `${index + 1}. ${token.name || "Unknown"} (${token.symbol || "N/A"}):\n` +
                `   Price: ${priceFormatted}\n` +
                `   Volume 24h: ${volume}\n` +
                `   Liquidity: ${liquidity}`
            );
        })
        .join("\n\n");

    return `Here are the trending tokens on ${chain.charAt(0).toUpperCase() + chain.slice(1)}:\n\n${formattedTokens}`;
};

export const trendingTokensProvider: Provider = {
    get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        const apiKey = runtime.getSetting("BIRDEYE_API_KEY");
        if (!apiKey) {
            return null;
        }

        const messageText = message.content.text.toLowerCase();

        // Check if message contains trending-related keywords
        const hasTrendingKeyword = TRENDING_KEYWORDS.some((keyword) =>
            messageText.includes(keyword)
        );

        // Check if message contains token-related keywords
        const hasTokenKeyword = TOKEN_KEYWORDS.some((keyword) =>
            messageText.includes(keyword)
        );

        // Check if the message is a direct question about trends
        const isQuestionAboutTrends =
            messageText.includes("?") &&
            (messageText.includes("what") ||
                messageText.includes("which") ||
                messageText.includes("show")) &&
            hasTrendingKeyword;

        // Check recent conversation context from state
        const recentMessages = (state?.recentMessagesData || []) as Memory[];
        const isInTrendingConversation = recentMessages.some(
            (msg) =>
                msg.content?.text?.toLowerCase().includes("trending") ||
                msg.content?.text?.toLowerCase().includes("token")
        );

        // Determine sorting direction based on keywords
        const isAscending = ASCENDING_KEYWORDS.some((keyword) =>
            messageText.includes(keyword)
        );
        const sortType = isAscending ? "asc" : "desc";

        // Determine if this is a pagination request
        const isPaginationRequest = PAGINATION_KEYWORDS.some((keyword) =>
            messageText.includes(keyword)
        );

        // Get the current offset from state or default to 0
        const currentOffset = (state?.trendingTokensOffset as number) || 0;
        const offset = isPaginationRequest ? currentOffset + 10 : 0;

        // Determine sort criteria based on message content
        let sortBy: "volume24hUSD" | "rank" | "liquidity" = "volume24hUSD";
        if (messageText.includes("liquidity")) {
            sortBy = "liquidity";
        } else if (messageText.includes("rank")) {
            sortBy = "rank";
        }

        // Determine which chain is being asked about
        const requestedChain =
            SUPPORTED_CHAINS.find((chain) =>
                messageText.includes(chain.toLowerCase())
            ) || "solana";

        // Combine signals to make decision
        const shouldProvideData =
            // Direct questions about trends
            isQuestionAboutTrends ||
            // Explicit mentions of trending tokens
            (hasTrendingKeyword && hasTokenKeyword) ||
            // Follow-up in a trending conversation
            (isInTrendingConversation && hasTokenKeyword) ||
            // Pagination request in conversation context
            (isPaginationRequest && isInTrendingConversation);

        if (!shouldProvideData) {
            return null;
        }

        elizaLogger.info(
            `TRENDING TOKENS provider activated for ${requestedChain} trending tokens query`
        );

        const trendingTokens = await getTrendingTokens(apiKey, {
            sort_by: sortBy,
            sort_type: sortType,
            offset,
            limit: 10,
            min_liquidity: 1000,
            chain: requestedChain,
        });

        const formattedTrending = formatTrendingTokensToString(
            trendingTokens,
            requestedChain
        );

        return formattedTrending;
    },
};
