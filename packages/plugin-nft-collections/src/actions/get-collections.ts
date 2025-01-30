import type { State } from "@elizaos/core";
import type { HandlerCallback } from "@elizaos/core";
import type { Action, IAgentRuntime, Memory, Provider } from "@elizaos/core";

export const getCollectionsAction = (
    nftCollectionProvider: Provider
): Action => {
    return {
        name: "GET_NFT_COLLECTIONS",
        similes: ["LIST_NFT_COLLECTIONS", "SHOW_NFT_COLLECTIONS"],
        description:
            "Fetches information about curated NFT collections on Ethereum",
        validate: async (_runtime: IAgentRuntime, message: Memory) => {
            return message.content.text
                .toLowerCase()
                .includes("nft collections");
        },
        handler: async (
            runtime: IAgentRuntime,
            message: Memory,
            _state: State,
            _options: { [key: string]: unknown },
            callback: HandlerCallback
        ) => {
            try {
                const response = await nftCollectionProvider.get(
                    runtime,
                    message
                );
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
                const errorMessage = error instanceof Error 
                    ? `Failed to fetch NFT collections: ${error.message}`
                    : "An unexpected error occurred while fetching NFT collections.";
                console.error(errorMessage);
                await runtime.messageManager.createMemory({
                    id: message.id,
                    content: { text: errorMessage },
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
                        text: "Can you tell me about the top NFT collections?",
                    },
                },
                {
                    user: "{{user2}}",
                    content: {
                        text: "Certainly! Here are the top NFT collections on Ethereum:",
                        action: "GET_NFT_COLLECTIONS",
                    },
                },
            ],
            [
                {
                    user: "{{user1}}",
                    content: {
                        text: "Can you show me a list of NFT collections?",
                    },
                },
                {
                    user: "{{user2}}",
                    content: {
                        text: "Sure! Here are some curated NFT collections on Ethereum:",
                        action: "GET_NFT_COLLECTIONS",
                    },
                },
            ],
            [
                {
                    user: "{{user1}}",
                    content: {
                        text: "Do you know the best NFT collections?",
                    },
                },
                {
                    user: "{{user2}}",
                    content: {
                        text: "Absolutely! Here's a list of top NFT collections on Ethereum:",
                        action: "GET_NFT_COLLECTIONS",
                    },
                },
            ],
            [
                {
                    user: "{{user1}}",
                    content: {
                        text: "Can you fetch Ethereum NFT collections for me?",
                    },
                },
                {
                    user: "{{user2}}",
                    content: {
                        text: "Of course! Fetching NFT collections on Ethereum:",
                        action: "GET_NFT_COLLECTIONS",
                    },
                },
            ],
            [
                {
                    user: "{{user1}}",
                    content: {
                        text: "I'm curious about NFTs. What are some collections I should look into?",
                    },
                },
                {
                    user: "{{user2}}",
                    content: {
                        text: "Here are some NFT collections you might find interesting:",
                        action: "GET_NFT_COLLECTIONS",
                    },
                },
            ],
            [
                {
                    user: "{{user1}}",
                    content: {
                        text: "Tell me about the trending Ethereum NFT collections.",
                    },
                },
                {
                    user: "{{user2}}",
                    content: {
                        text: "Here's information on trending Ethereum NFT collections:",
                        action: "GET_NFT_COLLECTIONS",
                    },
                },
            ],
            [
                {
                    user: "{{user1}}",
                    content: {
                        text: "What are some cool NFT collections right now?",
                    },
                },
                {
                    user: "{{user2}}",
                    content: {
                        text: "Let me show you some popular NFT collections:",
                        action: "GET_NFT_COLLECTIONS",
                    },
                },
            ],
        ],
    };
};
