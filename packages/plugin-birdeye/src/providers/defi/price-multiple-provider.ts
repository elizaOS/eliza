import {
    IAgentRuntime,
    Memory,
    Provider,
    State,
    elizaLogger,
} from "@elizaos/core";

// Types
interface TokenPrice {
    price: number;
    timestamp: number;
    token: string;
    priceChange24h?: number;
    priceChange24hPercent?: number;
}

interface MultiPriceResponse {
    [tokenAddress: string]: TokenPrice;
}

// Constants
const PRICE_KEYWORDS = [
    "price",
    "prices",
    "cost",
    "worth",
    "value",
    "compare",
    "multiple",
    "several",
    "many",
    "list of",
    "these tokens",
    "their prices",
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
const containsPriceKeyword = (text: string): boolean => {
    return PRICE_KEYWORDS.some((keyword) =>
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

const getMultiplePrices = async (
    apiKey: string,
    addresses: string[],
    chain: string = "solana"
): Promise<MultiPriceResponse | null> => {
    try {
        const params = new URLSearchParams({
            tokens: addresses.join(","),
        });
        const url = `${BASE_URL}/defi/price_multiple?${params.toString()}`;

        elizaLogger.info(
            `Fetching prices for ${addresses.length} tokens on ${chain} from:`,
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
        elizaLogger.error("Error fetching multiple prices:", error);
        return null;
    }
};

const formatNumber = (num: number): string => {
    if (!num && num !== 0) return "N/A";
    return num < 0.01
        ? num.toExponential(2)
        : num.toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
          });
};

const formatPriceResponse = (
    prices: MultiPriceResponse,
    chain: string
): string => {
    const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);
    let response = `Token Prices on ${chainName}:\n\n`;

    const sortedTokens = Object.entries(prices).sort((a, b) => {
        const priceA = a[1].price || 0;
        const priceB = b[1].price || 0;
        return priceB - priceA;
    });

    sortedTokens.forEach(([address, data]) => {
        const timestamp = new Date(data.timestamp * 1000).toLocaleString();
        response += `${data.token} (${address.slice(0, 6)}...${address.slice(-4)}):\n`;
        response += `• Price: $${formatNumber(data.price)}\n`;

        if (data.priceChange24h !== undefined) {
            const changeSymbol = data.priceChange24h >= 0 ? "📈" : "📉";
            response += `• 24h Change: ${changeSymbol} $${formatNumber(Math.abs(data.priceChange24h))} `;
            if (data.priceChange24hPercent !== undefined) {
                response += `(${data.priceChange24hPercent.toFixed(2)}%)`;
            }
            response += "\n";
        }

        response += `• Last Updated: ${timestamp}\n\n`;
    });

    return response;
};

export const priceMultipleProvider: Provider = {
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

        if (!containsPriceKeyword(messageText)) {
            return null;
        }

        const addresses = extractContractAddresses(messageText);
        if (addresses.length < 2) {
            // If less than 2 addresses found, let the single price provider handle it
            return null;
        }

        const chain = extractChain(messageText);

        elizaLogger.info(
            `MULTIPLE PRICE provider activated for ${addresses.length} addresses on ${chain}`
        );

        const priceData = await getMultiplePrices(apiKey, addresses, chain);

        if (!priceData) {
            return null;
        }

        return formatPriceResponse(priceData, chain);
    },
};
