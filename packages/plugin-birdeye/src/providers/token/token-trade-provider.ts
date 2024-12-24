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
    price: number;
    volume: number;
    side: "buy" | "sell";
    source: string;
    txHash: string;
    buyer?: string;
    seller?: string;
}

interface TokenTradeData {
    trades: Trade[];
    totalCount: number;
    token: string;
}

interface MultiTokenTradeData {
    [tokenAddress: string]: TokenTradeData;
}

// Constants
const TRADE_KEYWORDS = [
    "trades",
    "trading",
    "transactions",
    "swaps",
    "buys",
    "sells",
    "orders",
    "executions",
    "trade history",
    "trading history",
    "recent trades",
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
const containsTradeKeyword = (text: string): boolean => {
    return TRADE_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const extractChain = (text: string): string => {
    const chain = CHAIN_KEYWORDS.find((chain) =>
        text.toLowerCase().includes(chain.toLowerCase())
    );
    return chain || "solana";
};

const extractContractAddresses = (text: string): string[] => {
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

const getSingleTokenTrades = async (
    apiKey: string,
    contractAddress: string,
    chain: string = "solana",
    limit: number = 10
): Promise<TokenTradeData | null> => {
    try {
        const params = new URLSearchParams({
            address: contractAddress,
            limit: limit.toString(),
        });
        const url = `${BASE_URL}/token/trade_data_single?${params.toString()}`;

        elizaLogger.info(
            `Fetching trade data for token ${contractAddress} on ${chain} from:`,
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
        elizaLogger.error("Error fetching token trade data:", error);
        return null;
    }
};

const getMultipleTokenTrades = async (
    apiKey: string,
    addresses: string[],
    chain: string = "solana",
    limit: number = 5
): Promise<MultiTokenTradeData | null> => {
    try {
        const params = new URLSearchParams({
            addresses: addresses.join(","),
            limit: limit.toString(),
        });
        const url = `${BASE_URL}/token/trade_data_multiple?${params.toString()}`;

        elizaLogger.info(
            `Fetching trade data for ${addresses.length} tokens on ${chain} from:`,
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
        elizaLogger.error("Error fetching multiple token trade data:", error);
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
        trade.price != null
            ? trade.price < 0.01
                ? trade.price.toExponential(2)
                : trade.price.toFixed(2)
            : "N/A";
    const side = trade.side === "buy" ? "🟢 Buy" : "🔴 Sell";

    let response = `${side} - ${timestamp}\n`;
    response += `• Price: $${priceFormatted}\n`;
    response += `• Volume: ${trade.volume ? formatValue(trade.volume) : "N/A"}\n`;
    response += `• Source: ${trade.source || "Unknown"}\n`;
    if (trade.buyer && trade.seller) {
        response += `• Buyer: ${shortenAddress(trade.buyer)}\n`;
        response += `• Seller: ${shortenAddress(trade.seller)}\n`;
    }
    response += `• Tx: ${trade.txHash ? shortenAddress(trade.txHash) : "N/A"}`;

    return response;
};

const formatSingleTokenTradeResponse = (
    data: TokenTradeData,
    chain: string
): string => {
    const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);
    let response = `Recent Trades for ${data.token} on ${chainName}:\n\n`;

    if (data.trades.length === 0) {
        return response + "No recent trades found.";
    }

    data.trades.forEach((trade, index) => {
        response += `${index + 1}. ${formatTrade(trade)}\n\n`;
    });

    if (data.totalCount > data.trades.length) {
        response += `Showing ${data.trades.length} of ${data.totalCount} total trades.`;
    }

    return response;
};

const formatMultipleTokenTradeResponse = (
    data: MultiTokenTradeData,
    chain: string
): string => {
    const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);
    let response = `Recent Trades on ${chainName}:\n\n`;

    const tokens = Object.entries(data);
    if (tokens.length === 0) {
        return response + "No trades found for any token.";
    }

    tokens.forEach(([address, tokenData]) => {
        response += `${tokenData.token} (${shortenAddress(address)}):\n`;

        if (tokenData.trades.length === 0) {
            response += "No recent trades\n\n";
            return;
        }

        tokenData.trades.forEach((trade, index) => {
            response += `${index + 1}. ${formatTrade(trade)}\n`;
        });

        if (tokenData.totalCount > tokenData.trades.length) {
            response += `Showing ${tokenData.trades.length} of ${tokenData.totalCount} trades\n`;
        }
        response += "\n";
    });

    return response;
};

export const tokenTradeProvider: Provider = {
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

        if (!containsTradeKeyword(messageText)) {
            return null;
        }

        const addresses = extractContractAddresses(messageText);
        if (addresses.length === 0) {
            return null;
        }

        const chain = extractChain(messageText);

        if (addresses.length === 1) {
            elizaLogger.info(
                `TOKEN TRADE provider activated for address ${addresses[0]} on ${chain}`
            );

            const tradeData = await getSingleTokenTrades(
                apiKey,
                addresses[0],
                chain
            );

            if (!tradeData) {
                return null;
            }

            return formatSingleTokenTradeResponse(tradeData, chain);
        } else {
            elizaLogger.info(
                `MULTIPLE TOKEN TRADE provider activated for ${addresses.length} addresses on ${chain}`
            );

            const tradeData = await getMultipleTokenTrades(
                apiKey,
                addresses,
                chain
            );

            if (!tradeData) {
                return null;
            }

            return formatMultipleTokenTradeResponse(tradeData, chain);
        }
    },
};
