import type { Action, IAgentRuntime, Memory, State } from "@elizaos/core";
import type { ReservoirService } from "../services/reservoir";
import type { HandlerCallback } from "@elizaos/core";

// Helper function to extract NFT listing details from the message
function extractListingDetails(text: string): {
    tokenId: string | null;
    collectionAddress: string | null;
    price?: number | null;
} {
    const addressMatch = text.match(/(?:collection|from)\s*(0x[a-fA-F0-9]+)/i);
    const tokenIdMatch = text.match(/(?:token|nft)\s*#?\s*(\d+)/i);
    const priceMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:eth|Ξ)/i);

    return {
        collectionAddress: addressMatch ? addressMatch[1] : null,
        tokenId: tokenIdMatch ? tokenIdMatch[1] : null,
        price: priceMatch ? Number.parseFloat(priceMatch[1]) : undefined,
    };
}

export const listNFTAction = (nftService: ReservoirService): Action => {
    return {
        name: "LIST_NFT",
        similes: ["SELL_NFT", "CREATE_LISTING"],
        description:
            "Lists an NFT for sale on ikigailabs.xyz marketplace at double the purchase price.",

        validate: async (_runtime: IAgentRuntime, message: Memory) => {
            const content = message.content.text.toLowerCase();
            return (
                (content.includes("list") || content.includes("sell")) &&
                content.includes("nft") &&
                (content.includes("0x") ||
                    content.includes("token") ||
                    content.includes("#"))
            );
        },

        handler: async (
            runtime: IAgentRuntime,
            message: Memory,
            _state: State,
            _options: { [key: string]: unknown },
            callback: HandlerCallback
        ) => {
            try {
                const {
                    collectionAddress,
                    tokenId,
                    price: userSpecifiedPrice,
                } = extractListingDetails(message.content.text);

                if (!collectionAddress || !tokenId) {
                    throw new Error(
                        "Please provide the collection address and token ID"
                    );
                }

                if (!nftService) {
                    throw new Error("NFT service not found");
                }

                // Verify ownership before listing
                const ownedNFTs = await nftService.getOwnedNFTs(message.userId);
                const ownedNFT = ownedNFTs.find(
                    (nft) =>
                        nft.collectionAddress.toLowerCase() ===
                            collectionAddress.toLowerCase() &&
                        nft.tokenId === tokenId
                );

                if (!ownedNFT) {
                    throw new Error("You don't own this NFT");
                }

                // Create the listing on ikigailabs
                const listing = await nftService.createListing({
                    tokenId,
                    collectionAddress,
                    price: userSpecifiedPrice || 0, // Default to 0 if no price specified
                    marketplace: "ikigailabs",
                    expirationTime:
                        Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days
                });

                const response = `Successfully created listing on ikigailabs.xyz:
• Collection: ${collectionAddress}
• Token ID: ${tokenId}
• Listing Price: ${userSpecifiedPrice} ETH
• Status: ${listing.status}
• Listing URL: ${listing.marketplaceUrl}
${listing.transactionHash ? `• Transaction: ${listing.transactionHash}` : ''}`;

                callback({
                    text: response,
                });

                await runtime.messageManager.createMemory({
                    id: message.id,
                    content: { text: response },
                    roomId: message.roomId,
                    userId: message.userId,
                    agentId: runtime.agentId,
                });

                return true;
            } catch (error) {
                console.error("NFT listing failed:", error);
                await runtime.messageManager.createMemory({
                    id: message.id,
                    content: {
                        text: `Failed to list NFT: ${error.message}`,
                    },
                    roomId: message.roomId,
                    userId: message.userId,
                    agentId: runtime.agentId,
                });
                return false;
            }
        },

        examples: [
            [
                {
                    user: "{{user1}}",
                    content: {
                        text: "List token #123 from collection 0x1234...abcd",
                    },
                },
                {
                    user: "{{user2}}",
                    content: {
                        text: "Creating listing on ikigailabs.xyz at 2x purchase price...",
                        action: "LIST_NFT",
                    },
                },
            ],
            [
                {
                    user: "{{user1}}",
                    content: {
                        text: "List token #123 from collection 0x1234...abcd for 5 ETH",
                    },
                },
                {
                    user: "{{user2}}",
                    content: {
                        text: "Creating listing on ikigailabs.xyz with specified price...",
                        action: "LIST_NFT",
                    },
                },
            ],
        ],
    };
};
