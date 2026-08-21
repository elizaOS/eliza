import {
    type Action,
    type IAgentRuntime,
    type Memory,
    type State,
    logger,
} from "@elizaos/core";
import { FeedoClient } from "feedo-protocol-sdk";

export const storeFeedoAction: Action = {
    name: "STORE_IN_FEEDO",
    similes: ["SAVE_MEMORY", "REMEMBER", "STORE_CONTEXT", "ADD_TO_FEEDO"],
    description:
        "Saves important information, user preferences, or long-term context to the decentralized Feedo Memory Network.",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        const usageKey = runtime.getSetting("FEEDO_USAGE_KEY");
        const did = runtime.getSetting("FEEDO_AGENT_DID");
        return !!(usageKey && did);
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State,
        _options?: any,
        _callback?: any
    ) => {
        try {
            const usageKey = runtime.getSetting("FEEDO_USAGE_KEY");
            const did = runtime.getSetting("FEEDO_AGENT_DID");
            
            if (!usageKey || !did) return false;

            const contentToStore = message.content?.text;
            if (!contentToStore) return false;

            const client = new FeedoClient({ usageKey, did });
            
            // Store the memory in the decentralized network
            await client.search.indexDocument(contentToStore);
            
            logger.success(`Successfully saved memory to Feedo Protocol: ${contentToStore}`);
            return true;
        } catch (error) {
            logger.error("Failed to store memory in Feedo Protocol:", error);
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "My favorite color is blue." },
            },
            {
                user: "{{user2}}",
                content: { text: "I'll remember that your favorite color is blue.", action: "STORE_IN_FEEDO" },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Please remember that my API key is 12345." },
            },
            {
                user: "{{user2}}",
                content: { text: "Stored securely in my long-term memory.", action: "STORE_IN_FEEDO" },
            },
        ]
    ],
};
