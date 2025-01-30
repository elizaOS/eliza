import type { Evaluator, IAgentRuntime, Memory, State } from "@elizaos/core";
import type { NFTKnowledge } from "../types";

export const nftKnowledgeEvaluator: Evaluator = {
    name: "nft-collection-evaluator",
    description: "Evaluates NFT-related content in messages",
    similes: [
        "nft-evaluator",
        "nft-knowledge",
        "market-analysis",
        "artist-info",
    ],
    alwaysRun: false,
    validate: async (_runtime: IAgentRuntime, message: Memory) => {
        const content = message.content.text.toLowerCase();
        return (
            content.includes("nft") ||
            content.includes("collection") ||
            content.includes("market") ||
            content.includes("trading") ||
            content.includes("artist") ||
            content.includes("contract") ||
            content.includes("news") ||
            content.includes("onchain")
        );
    },
    handler: async (_runtime: IAgentRuntime, message: Memory, state: State) => {
        const content = message.content.text.toLowerCase();

        const extractedInfo: NFTKnowledge = {
            mentionsCollection:
                content.includes("collection") || content.includes("nft"),
            mentionsFloorPrice:
                content.includes("floor price") || content.includes("floor"),
            mentionsVolume:
                content.includes("volume") ||
                content.includes("trading volume"),
            mentionsRarity:
                content.includes("rare") || content.includes("rarity"),
            mentionsMarketTrends:
                content.includes("trend") ||
                content.includes("market") ||
                content.includes("movement"),
            mentionsTraders:
                content.includes("trader") ||
                content.includes("whale") ||
                content.includes("investor"),
            mentionsSentiment:
                content.includes("bull") ||
                content.includes("bear") ||
                content.includes("sentiment") ||
                content.includes("mood"),
            mentionsMarketCap:
                content.includes("market cap") ||
                content.includes("marketcap") ||
                content.includes("valuation"),
            mentionsArtist:
                content.includes("artist") ||
                content.includes("creator") ||
                content.includes("founder"),
            mentionsOnChainData:
                content.includes("onchain") ||
                content.includes("blockchain") ||
                content.includes("contract") ||
                content.includes("holder") ||
                content.includes("transfer"),
            mentionsNews:
                content.includes("news") ||
                content.includes("announcement") ||
                content.includes("update"),
            mentionsSocial:
                content.includes("twitter") ||
                content.includes("discord") ||
                content.includes("telegram") ||
                content.includes("social"),
            mentionsContract:
                content.includes("contract") ||
                content.includes("royalty") ||
                content.includes("standard") ||
                content.includes("erc"),
        };

        return {
            ...state,
            nftKnowledge: extractedInfo,
        };
    },
    examples: [
        {
            context: "Evaluating comprehensive NFT collection data",
            messages: [
                {
                    user: "{{user1}}",
                    content: {
                        text: "Tell me about the artist and on-chain stats for this collection",
                    },
                },
                {
                    user: "{{user2}}",
                    content: {
                        text: "I'll analyze the creator's background and blockchain metrics.",
                    },
                },
            ],
            outcome:
                "The message requests artist and on-chain information and should be evaluated.",
        },
    ],
};
