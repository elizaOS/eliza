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
    formatValue,
    makeApiRequest,
} from "../utils";

// Types
interface TokenMetadata {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    totalSupply: number;
    totalSupplyUSD: number;
    website: string;
    twitter: string;
    telegram: string;
    discord: string;
    coingeckoId: string;
    description: string;
    logo: string;
    tags: string[];
}

interface MetadataResponse {
    metadata: TokenMetadata;
}

// Constants
const METADATA_KEYWORDS = [
    "metadata",
    "token info",
    "token information",
    "token details",
    "token data",
    "token description",
    "token profile",
    "token overview",
    "token stats",
    "token statistics",
    "token social",
    "token links",
    "token website",
    "token socials",
] as const;

// Helper functions
const containsMetadataKeyword = (text: string): boolean => {
    return METADATA_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const getTokenMetadata = async (
    apiKey: string,
    contractAddress: string,
    chain: Chain
): Promise<MetadataResponse | null> => {
    try {
        const params = new URLSearchParams({
            address: contractAddress,
        });
        const url = `${BASE_URL}/token/metadata?${params.toString()}`;

        elizaLogger.info(
            `Fetching token metadata for ${contractAddress} on ${chain} from:`,
            url
        );

        return await makeApiRequest<MetadataResponse>(url, { apiKey, chain });
    } catch (error) {
        if (error instanceof Error) {
            elizaLogger.error("Error fetching token metadata:", error.message);
        }
        return null;
    }
};

const formatSocialLinks = (metadata: TokenMetadata): string => {
    const links = [];

    if (metadata.website) {
        links.push(`🌐 [Website](${metadata.website})`);
    }
    if (metadata.twitter) {
        links.push(`🐦 [Twitter](${metadata.twitter})`);
    }
    if (metadata.telegram) {
        links.push(`📱 [Telegram](${metadata.telegram})`);
    }
    if (metadata.discord) {
        links.push(`💬 [Discord](${metadata.discord})`);
    }
    if (metadata.coingeckoId) {
        links.push(
            `🦎 [CoinGecko](https://www.coingecko.com/en/coins/${metadata.coingeckoId})`
        );
    }

    return links.length > 0 ? links.join("\n") : "No social links available";
};

const formatMetadataResponse = (
    data: MetadataResponse,
    chain: Chain
): string => {
    const { metadata } = data;
    const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);

    let response = `Token Metadata for ${metadata.name} (${metadata.symbol}) on ${chainName}\n\n`;

    // Basic Information
    response += "📝 Basic Information\n";
    response += `• Name: ${metadata.name}\n`;
    response += `• Symbol: ${metadata.symbol}\n`;
    response += `• Address: ${metadata.address}\n`;
    response += `• Decimals: ${metadata.decimals}\n`;
    response += `• Total Supply: ${formatValue(metadata.totalSupply)}\n`;
    response += `• Total Supply USD: ${formatValue(metadata.totalSupplyUSD)}\n`;

    // Description
    if (metadata.description) {
        response += "\n📋 Description\n";
        response += metadata.description + "\n";
    }

    // Tags
    if (metadata.tags && metadata.tags.length > 0) {
        response += "\n🏷️ Tags\n";
        response += metadata.tags.map((tag) => `#${tag}`).join(" ") + "\n";
    }

    // Social Links
    response += "\n🔗 Social Links\n";
    response += formatSocialLinks(metadata) + "\n";

    // Logo
    if (metadata.logo) {
        response += "\n🖼️ Logo\n";
        response += metadata.logo;
    }

    return response;
};

export const tokenMetadataProvider: Provider = {
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

        if (!containsMetadataKeyword(messageText)) {
            return null;
        }

        const addresses = extractContractAddresses(messageText);
        if (addresses.length === 0) {
            return null;
        }

        const chain = extractChain(messageText);

        elizaLogger.info(
            `TOKEN METADATA provider activated for ${addresses[0]} on ${chain}`
        );

        const metadataData = await getTokenMetadata(
            apiKey,
            addresses[0],
            chain
        );

        if (!metadataData) {
            return null;
        }

        return formatMetadataResponse(metadataData, chain);
    },
};
