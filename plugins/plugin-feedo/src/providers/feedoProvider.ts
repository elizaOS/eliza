/**
 * Provider for fetching relevant context from Feedo decentralized memory network.
 * Context is scoped to the current roomId for isolation.
 */
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
            
            const query = message.content?.text;
            if (!query || query.length < 3) {
                return { text: "" };
            }

            if (context?.signal?.aborted) {
                throw new Error("Provider execution aborted before network call");
            }

            // Isolate memory by roomId to prevent cross-user data leakage
            const namespace = message.roomId;

            // Perform bounded/cancellable network transport via Promise.race
            const searchPromise = client.search.search(
                query, 
                5, 
                true, 
                "all", 
                0, 
                undefined, 
                "text", 
                undefined, 
                namespace
            );

            const abortPromise = new Promise<never>((_, reject) => {
                if (context?.signal) {
                    context.signal.addEventListener("abort", () => {
                        reject(new Error("Provider execution aborted during network call"));
                    });
                }
            });

            // If context.signal is defined, race the search against the abort promise
            const searchResults = context?.signal 
                ? await Promise.race([searchPromise, abortPromise])
                : await searchPromise;
                
            const documents = searchResults?.documents || searchResults?.data || searchResults || [];
            
            if (!documents || documents.length === 0) {
                return { text: "" };
            }

            // Format results for the LLM context
            const formattedResults = documents
                .slice(0, 5)
                .map((result: { text?: string; content?: string }, i: number) => `[Memory ${i + 1}] ${result.text || result.content || JSON.stringify(result)}`)
                .join("\n");

            return {
                text: `Relevant Context from Feedo Decentralized Memory:\n${formattedResults}`,
                data: documents,
            };
        } catch (error) {
            logger.error("Error retrieving context from Feedo Protocol:", { error });
            runtime.reportError?.(error as Error);
            return { text: "" };
        }
    },
};
