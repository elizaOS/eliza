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
    formatTimestamp,
    formatValue,
    makeApiRequest,
} from "../utils";

// Types
interface PriceVolumeData {
    price: number;
    volume24h: number;
    timestamp: number;
    token: string;
    priceChange24h?: number;
    priceChange24hPercent?: number;
    volumeChange24h?: number;
    volumeChange24hPercent?: number;
}

interface MultiPriceVolumeResponse {
    [tokenAddress: string]: PriceVolumeData;
}

// Constants
const PRICE_VOLUME_KEYWORDS = [
    "price and volume",
    "volume and price",
    "trading volume",
    "market activity",
    "market data",
    "trading data",
    "market stats",
    "trading stats",
    "market metrics",
    "trading metrics",
] as const;

// Helper functions
const containsPriceVolumeKeyword = (text: string): boolean => {
    return PRICE_VOLUME_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const getSinglePriceVolume = async (
    apiKey: string,
    contractAddress: string,
    chain: Chain
): Promise<PriceVolumeData | null> => {
    try {
        const params = new URLSearchParams({
            address: contractAddress,
        });
        const url = `${BASE_URL}/defi/price_volume_single?${params.toString()}`;

        elizaLogger.info(
            `Fetching price/volume data for address ${contractAddress} on ${chain} from:`,
            url
        );

        return await makeApiRequest<PriceVolumeData>(url, { apiKey, chain });
    } catch (error) {
        if (error instanceof Error) {
            elizaLogger.error(
                "Error fetching price/volume data:",
                error.message
            );
        }
        return null;
    }
};

const getMultiplePriceVolume = async (
    apiKey: string,
    addresses: string[],
    chain: Chain
): Promise<MultiPriceVolumeResponse | null> => {
    try {
        const url = `${BASE_URL}/defi/price_volume_multi`;

        elizaLogger.info(
            `Fetching price/volume data for ${addresses.length} tokens on ${chain}`
        );

        return await makeApiRequest<MultiPriceVolumeResponse>(url, {
            apiKey,
            chain,
            method: "POST",
            body: { addresses },
        });
    } catch (error) {
        if (error instanceof Error) {
            elizaLogger.error(
                "Error fetching multiple price/volume data:",
                error.message
            );
        }
        return null;
    }
};

const formatSinglePriceVolumeResponse = (
    data: PriceVolumeData,
    chain: Chain
): string => {
    const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);
    const timestamp = formatTimestamp(data.timestamp);
    const priceFormatted = formatValue(data.price);

    let response = `Price & Volume Data for ${data.token} on ${chainName}:\n\n`;

    response += `💰 Price Metrics\n`;
    response += `• Current Price: ${priceFormatted}\n`;
    if (data.priceChange24h !== undefined) {
        response += `• 24h Price Change: ${formatValue(data.priceChange24h)} (${formatPercentChange(data.priceChange24hPercent)})\n`;
    }

    response += `\n📊 Volume Metrics\n`;
    response += `• 24h Volume: ${formatValue(data.volume24h)}\n`;
    if (data.volumeChange24h !== undefined) {
        response += `• 24h Volume Change: ${formatValue(data.volumeChange24h)} (${formatPercentChange(data.volumeChange24hPercent)})\n`;
    }

    response += `\n⏰ Last Updated: ${timestamp}`;

    return response;
};

const formatMultiplePriceVolumeResponse = (
    data: MultiPriceVolumeResponse,
    chain: Chain
): string => {
    const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);
    let response = `Price & Volume Data on ${chainName}:\n\n`;

    // Sort tokens by volume
    const sortedTokens = Object.entries(data).sort((a, b) => {
        const volumeA = a[1].volume24h || 0;
        const volumeB = b[1].volume24h || 0;
        return volumeB - volumeA;
    });

    sortedTokens.forEach(([address, tokenData]) => {
        const timestamp = formatTimestamp(tokenData.timestamp);
        const priceFormatted = formatValue(tokenData.price);

        response += `${tokenData.token} (${address.slice(0, 6)}...${address.slice(-4)})\n`;
        response += `• Price: ${priceFormatted}`;
        if (tokenData.priceChange24hPercent !== undefined) {
            response += ` (${formatPercentChange(tokenData.priceChange24hPercent)})`;
        }
        response += `\n`;
        response += `• Volume: ${formatValue(tokenData.volume24h)}`;
        if (tokenData.volumeChange24hPercent !== undefined) {
            response += ` (${formatPercentChange(tokenData.volumeChange24hPercent)})`;
        }
        response += `\n`;
        response += `• Updated: ${timestamp}\n\n`;
    });

    return response;
};

export const priceVolumeProvider: Provider = {
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

        if (!containsPriceVolumeKeyword(messageText)) {
            return null;
        }

        const addresses = extractContractAddresses(messageText);
        if (addresses.length === 0) {
            return null;
        }

        const chain = extractChain(messageText);

        if (addresses.length === 1) {
            elizaLogger.info(
                `PRICE/VOLUME provider activated for address ${addresses[0]} on ${chain}`
            );

            const priceVolumeData = await getSinglePriceVolume(
                apiKey,
                addresses[0],
                chain
            );

            if (!priceVolumeData) {
                return null;
            }

            return formatSinglePriceVolumeResponse(priceVolumeData, chain);
        } else {
            elizaLogger.info(
                `MULTIPLE PRICE/VOLUME provider activated for ${addresses.length} addresses on ${chain}`
            );

            const priceVolumeData = await getMultiplePriceVolume(
                apiKey,
                addresses,
                chain
            );

            if (!priceVolumeData) {
                return null;
            }

            return formatMultiplePriceVolumeResponse(priceVolumeData, chain);
        }
    },
};
