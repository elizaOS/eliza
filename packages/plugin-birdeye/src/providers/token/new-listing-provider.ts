import {
    IAgentRuntime,
    Memory,
    Provider,
    State,
    elizaLogger,
} from "@elizaos/core";
import { BASE_URL, Chain, makeApiRequest } from "../utils";

// Types
interface TokenListing {
    address: string;
    name: string;
    symbol: string;
    listingTime: number;
    initialPrice: number;
    currentPrice: number;
    priceChange: number;
    volume24h: number;
}

interface NewListingsResponse {
    listings: TokenListing[];
}

// Constants
const NEW_LISTING_KEYWORDS = [
    "new listings",
    "newly listed",
    "recent listings",
    "latest tokens",
    "new tokens",
] as const;

// Helper functions
const containsNewListingKeyword = (text: string): boolean => {
    return NEW_LISTING_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const getNewListings = async (
    apiKey: string,
    chain: Chain = "solana"
): Promise<NewListingsResponse | null> => {
    try {
        const url = `${BASE_URL}/token/new_listing`;

        elizaLogger.info("Fetching new token listings from:", url);

        return await makeApiRequest<NewListingsResponse>(url, {
            apiKey,
            chain,
        });
    } catch (error) {
        if (error instanceof Error) {
            elizaLogger.error("Error fetching new listings:", error.message);
        }
        return null;
    }
};

const formatNewListingsResponse = (data: NewListingsResponse): string => {
    let response = "🆕 New Token Listings\n\n";

    data.listings.forEach((listing) => {
        const listingDate = new Date(
            listing.listingTime * 1000
        ).toLocaleString();
        const priceChangePercent = (listing.priceChange * 100).toFixed(2);
        const priceChangeEmoji = listing.priceChange >= 0 ? "📈" : "📉";

        response += `${listing.name} (${listing.symbol}) ${priceChangeEmoji}\n`;
        response += `• Address: ${listing.address}\n`;
        response += `• Listed: ${listingDate}\n`;
        response += `• Initial Price: $${listing.initialPrice.toFixed(6)}\n`;
        response += `• Current Price: $${listing.currentPrice.toFixed(6)}\n`;
        response += `• Price Change: ${priceChangePercent}%\n`;
        response += `• 24h Volume: $${listing.volume24h.toLocaleString()}\n\n`;
    });

    return response.trim();
};

export const newListingProvider: Provider = {
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

        if (!containsNewListingKeyword(messageText)) {
            return null;
        }

        elizaLogger.info("NEW_LISTING provider activated");

        const listingsData = await getNewListings(apiKey);

        if (!listingsData) {
            return null;
        }

        return formatNewListingsResponse(listingsData);
    },
};
