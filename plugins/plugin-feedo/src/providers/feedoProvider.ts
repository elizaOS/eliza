import {
    type IAgentRuntime,
    type Memory,
    type Provider,
    type State,
    logger,
} from "@elizaos/core";
import { FeedoClient } from "feedo-protocol-sdk";

export const feedoProvider: Provider = {
    name: "feedoProvider",
    get: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State
    ) => {
        try {
            const usageKey = runtime.getSetting("FEEDO_USAGE_KEY");
            const did = runtime.getSetting("FEEDO_AGENT_DID");
            
            if (!usageKey || !did) {
                return null;
            }

            const client = new FeedoClient({ usageKey, did });
            
            // Extract the user's message text
            const query = message.content?.text;
            if (!query || query.length < 3) {
                return null;
            }

            // Perform a search against Feedo's decentralized network
            const searchResults = await client.search.search(query, 5);
            const documents = searchResults.documents || searchResults.results || [];
            
            if (!documents || documents.length === 0) {
                return null;
            }

            // Format results for the LLM context
            const formattedResults = documents
                .slice(0, 5) // Limit to top 5 results to save context window
                .map((result: any, i: number) => `[Memory ${i + 1}] ${result.text || result.content}`)
                .join("\n");

            return {
                text: `Relevant Context from Feedo Decentralized Memory:\n${formattedResults}`,
                data: documents,
            };
        } catch (error) {
            logger.error("Error retrieving context from Feedo Protocol:", error);
            return null;
        }
    },
};
