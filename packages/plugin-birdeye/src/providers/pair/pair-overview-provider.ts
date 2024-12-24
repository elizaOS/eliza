import {
    IAgentRuntime,
    Memory,
    Provider,
    State,
    elizaLogger,
} from "@elizaos/core";

// Types
interface PairToken {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    logoURI?: string;
}

interface PairOverview {
    address: string;
    baseToken: PairToken;
    quoteToken: PairToken;
    price: number;
    priceChange24h: number;
    priceChange24hPercent: number;
    volume24h: number;
    liquidity: number;
    txCount24h: number;
    lastTradeUnixTime: number;
    dex: string;
}

interface MultiPairOverview {
    [pairAddress: string]: PairOverview;
}

// Constants
const PAIR_KEYWORDS = [
    "pair",
    "pairs",
    "trading pair",
    "market",
    "markets",
    "pool",
    "pools",
    "liquidity pool",
    "dex",
    "exchange",
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
const containsPairKeyword = (text: string): boolean => {
    return PAIR_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const extractChain = (text: string): string => {
    const chain = CHAIN_KEYWORDS.find((chain) =>
        text.toLowerCase().includes(chain.toLowerCase())
    );
    return chain || "solana";
};

const extractPairAddresses = (text: string): string[] => {
    const words = text.split(/\s+/);
    const addresses: string[] = [];

    for (const word of words) {
        // Ethereum-like addresses (0x...)
        if (/^0x[a-fA-F0-9]{40}$/i.test(word)) {
            addresses.push(word);
        }
        // Solana addresses (base58, typically 32-44 chars)
        if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(word)) {
            addresses.push(word);
        }
    }
    return addresses;
};

const getPairOverview = async (
    apiKey: string,
    pairAddress: string,
    chain: string = "solana"
): Promise<PairOverview | null> => {
    try {
        const params = new URLSearchParams({
            address: pairAddress,
        });
        const url = `${BASE_URL}/pair/overview_single?${params.toString()}`;

        elizaLogger.info(
            `Fetching pair overview for address ${pairAddress} on ${chain} from:`,
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
                elizaLogger.warn(`Pair not found: ${pairAddress} on ${chain}`);
                return null;
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return data.data;
    } catch (error) {
        elizaLogger.error("Error fetching pair overview:", error);
        return null;
    }
};

const getMultiplePairOverviews = async (
    apiKey: string,
    pairAddresses: string[],
    chain: string = "solana"
): Promise<MultiPairOverview | null> => {
    try {
        const params = new URLSearchParams({
            addresses: pairAddresses.join(","),
        });
        const url = `${BASE_URL}/pair/overview_multiple?${params.toString()}`;

        elizaLogger.info(
            `Fetching multiple pair overviews for ${pairAddresses.length} pairs on ${chain} from:`,
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
        elizaLogger.error("Error fetching multiple pair overviews:", error);
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

const formatPairOverview = (pair: PairOverview): string => {
    const lastTradeTime = new Date(
        pair.lastTradeUnixTime * 1000
    ).toLocaleString();
    const priceFormatted =
        pair.price < 0.01 ? pair.price.toExponential(2) : pair.price.toFixed(2);

    let response = `${pair.baseToken.symbol}/${pair.quoteToken.symbol} on ${pair.dex}\n`;
    response += `• Address: ${pair.address}\n`;
    response += `• Price: $${priceFormatted}\n`;

    const changeSymbol = pair.priceChange24h >= 0 ? "📈" : "📉";
    response += `• 24h Change: ${changeSymbol} ${pair.priceChange24hPercent.toFixed(2)}% (${formatValue(pair.priceChange24h)})\n`;
    response += `• 24h Volume: ${formatValue(pair.volume24h)}\n`;
    response += `• Liquidity: ${formatValue(pair.liquidity)}\n`;
    response += `• 24h Transactions: ${pair.txCount24h.toLocaleString()}\n`;
    response += `• Last Trade: ${lastTradeTime}\n`;

    return response;
};

const formatMultiplePairOverviews = (
    pairs: MultiPairOverview,
    chain: string
): string => {
    const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);
    let response = `Trading Pairs on ${chainName}:\n\n`;

    if (Object.keys(pairs).length === 0) {
        return response + "No pairs found.";
    }

    // Sort pairs by liquidity
    const sortedPairs = Object.values(pairs).sort(
        (a, b) => b.liquidity - a.liquidity
    );

    sortedPairs.forEach((pair, index) => {
        response += `${index + 1}. ${formatPairOverview(pair)}\n`;
    });

    return response;
};

export const pairOverviewProvider: Provider = {
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

        if (!containsPairKeyword(messageText)) {
            return null;
        }

        const pairAddresses = extractPairAddresses(messageText);
        if (pairAddresses.length === 0) {
            return null;
        }

        const chain = extractChain(messageText);

        if (pairAddresses.length === 1) {
            elizaLogger.info(
                `PAIR OVERVIEW provider activated for address ${pairAddresses[0]} on ${chain}`
            );

            const pairData = await getPairOverview(
                apiKey,
                pairAddresses[0],
                chain
            );

            if (!pairData) {
                return null;
            }

            return formatPairOverview(pairData);
        } else {
            elizaLogger.info(
                `MULTIPLE PAIR OVERVIEW provider activated for ${pairAddresses.length} pairs on ${chain}`
            );

            const pairData = await getMultiplePairOverviews(
                apiKey,
                pairAddresses,
                chain
            );

            if (!pairData) {
                return null;
            }

            return formatMultiplePairOverviews(pairData, chain);
        }
    },
};
