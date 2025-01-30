import type { Action, IAgentRuntime, Memory, State } from "@elizaos/core";
import type { ReservoirService } from "../services/reservoir";
import type { HandlerCallback } from "@elizaos/core";

// Helper function to extract NFT details from the message
function extractNFTDetails(text: string): {
    collectionAddress: string | null;
    quantity: number;
} {
    const addressMatch = text.match(/0x[a-fA-F0-9]{40}/);
    const quantityMatch = text.match(/\d+/);

    return {
        collectionAddress: addressMatch ? addressMatch[0] : null,
        quantity: quantityMatch ? Number.parseInt(quantityMatch[0]) : 1,
    };
}

export const sweepFloorAction = (nftService: ReservoirService): Action => {
    return {
        name: "SWEEP_FLOOR_NFT",
        similes: ["BUY_FLOOR_NFT", "PURCHASE_FLOOR_NFT"],
        description:
            "Sweeps the floor of a specified EVM NFT collection by purchasing the lowest-priced available NFTs.",

        validate: async (_runtime: IAgentRuntime, message: Memory) => {
            const content = message.content.text.toLowerCase();
            return (
                (content.includes("sweep") || content.includes("buy")) &&
                content.includes("nft") &&
                (content.includes("0x") || content.includes("floor"))
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
                const { collectionAddress, quantity } = extractNFTDetails(
                    message.content.text
                );

                if (!collectionAddress) {
                    throw new Error(
                        "No valid collection address found in message"
                    );
                }

                if (!nftService) {
                    throw new Error("NFT service not found");
                }

                // Get floor listings sorted by price
                const floorListings = await nftService.getFloorListings({
                    collection: collectionAddress,
                    limit: quantity,
                    sortBy: "price",
                });

                if (floorListings.length < quantity) {
                    throw new Error(
                        `Only ${floorListings.length} NFTs available at floor price`
                    );
                }

                // Execute the buy transaction
                const result = await nftService.executeBuy({
                    listings: floorListings,
                    taker: message.userId, // Assuming userId is the wallet address
                });

                const totalPrice = floorListings.reduce(
                    (sum, listing) => sum + listing.price,
                    0
                );
                const response =
                    `Successfully initiated sweep of ${quantity} NFTs from collection ${collectionAddress}:\n` +
                    `• Total Cost: ${totalPrice} ETH\n` +
                    `• Average Price: ${(totalPrice / quantity).toFixed(4)} ETH\n` +
                    `• Transaction Path: ${result.path}\n` +
                    `• Status: ${result.steps.map((step) => `${step.action} - ${step.status}`).join(", ")}`;
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
                console.error("Floor sweep failed:", error);
                await runtime.messageManager.createMemory({
                    id: message.id,
                    content: {
                        text: `Failed to sweep floor NFTs: ${error.message}`,
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
                        text: "Sweep 5 NFTs from collection 0x1234...abcd at floor price",
                    },
                },
                {
                    user: "{{user2}}",
                    content: {
                        text: "Executing floor sweep for 5 NFTs...",
                        action: "SWEEP_FLOOR_NFT",
                    },
                },
            ],
        ],
    };
};
