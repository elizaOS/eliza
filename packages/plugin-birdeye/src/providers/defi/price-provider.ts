import {
    IAgentRuntime,
    Memory,
    Provider,
    State,
    elizaLogger,
} from "@elizaos/core";

// Types
interface PriceData {
    price: number;
    timestamp: number;
    token: string;
    priceChange24h?: number;
    priceChange24hPercent?: number;
}

// Constants
const PRICE_KEYWORDS = [
    "price",
    "cost",
    "worth",
    "value",
    "rate",
    "quote",
    "how much",
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

const extractContractAddress = (text: string): string | null => {
    const words = text.split(/\s+/);

    for (const word of words) {
        // Ethereum-like addresses (0x...)
        if (/^0x[a-fA-F0-9]{40}$/i.test(word)) {
            return word;
        }
        // Solana addresses (base58, typically 32-44 chars)
        if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(word)) {
            return word;
        }
    }
    return null;
};

const getTokenPrice = async (
    apiKey: string,
    contractAddress: string,
    chain: string = "solana"
): Promise<PriceData | null> => {
    try {
        const params = new URLSearchParams({
            address: contractAddress,
        });
        const url = `${BASE_URL}/defi/price?${params.toString()}`;

        elizaLogger.info(
            `Fetching price for address ${contractAddress} on ${chain} from:`,
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
        elizaLogger.error("Error fetching token price:", error);
        return null;
    }
};

const formatPriceResponse = (price: PriceData, chain: string): string => {
    const timestamp = new Date(price.timestamp * 1000).toLocaleString();
    const priceFormatted =
        price.price < 0.01
            ? price.price.toExponential(2)
            : price.price.toFixed(2);

    let response = `Price for ${price.token} on ${chain.charAt(0).toUpperCase() + chain.slice(1)}:\n\n`;
    response += `• Current Price: $${priceFormatted}\n`;

    if (price.priceChange24h !== undefined) {
        response += `• 24h Change: $${price.priceChange24h.toFixed(2)}\n`;
    }

    if (price.priceChange24hPercent !== undefined) {
        response += `• 24h Change %: ${price.priceChange24hPercent.toFixed(2)}%\n`;
    }

    response += `• Last Updated: ${timestamp}`;

    return response;
};

export const priceProvider: Provider = {
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

        const contractAddress = extractContractAddress(messageText);
        if (!contractAddress) {
            return null;
        }

        const chain = extractChain(messageText);

        elizaLogger.info(
            `PRICE provider activated for address ${contractAddress} on ${chain}`
        );

        const priceData = await getTokenPrice(apiKey, contractAddress, chain);

        if (!priceData) {
            return null;
        }

        return formatPriceResponse(priceData, chain);
    },
};
