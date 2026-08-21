import {
    type IAgentRuntime,
    type Memory,
    type Provider,
    type State,
    type ProviderResult,
    type ProviderExecutionContext,
    logger,
} from "@elizaos/core";
import { FeedoClient } from "feedo-protocol-sdk";

export const feedoProvider: Provider = {
    name: "feedoProvider",
    get: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State,
        context?: ProviderExecutionContext
    ): Promise<ProviderResult> => {
        try {
            const usageKey = runtime.getSetting("FEEDO_USAGE_KEY");
            const did = runtime.getSetting("FEEDO_AGENT_DID");
            
            if (!usageKey || !did) {
                return { text: "" };
            }

            const client = new FeedoClient({ usageKey, did });
            
            // Extract the user's message text
            const query = message.content?.text;
            if (!query || query.length < 3) {
                return { text: "" };
            }

            // In older plugins, a raw fetch was used which supported AbortSignal.
            // Using the SDK now abstracts the HTTP layer, but we can still honor
            // the abort signal by short-circuiting before network calls or checking it after.
            if (context?.signal?.aborted) {
                throw new Error("Provider execution aborted");
            }

            // Perform a search against Feedo's decentralized network via SDK
            const searchResults = await client.search.search(query, 5);
            const documents = searchResults?.documents || searchResults?.data || searchResults || [];
            
            if (!documents || documents.length === 0) {
                return { text: "" };
            }

            // Format results for the LLM context
            const formattedResults = documents
                .slice(0, 5) // Limit to top 5 results to save context window
                .map((result: any, i: number) => `[Memory ${i + 1}] ${result.text || result.content || JSON.stringify(result)}`)
                .join("\n");

            return {
                text: `Relevant Context from Feedo Decentralized Memory:\n${formattedResults}`,
                data: documents,
            };
        } catch (error) {
            logger.error("Error retrieving context from Feedo Protocol:", { error });
            return { text: "" };
        }
    },
};
