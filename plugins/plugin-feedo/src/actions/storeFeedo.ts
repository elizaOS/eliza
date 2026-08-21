import {
    type Action,
    type ActionResult,
    type IAgentRuntime,
    type Memory,
    type State,
    type HandlerOptions,
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
        _options?: HandlerOptions,
        _callback?: any
    ): Promise<ActionResult | undefined> => {
        try {
            const usageKey = runtime.getSetting("FEEDO_USAGE_KEY");
            const did = runtime.getSetting("FEEDO_AGENT_DID");
            
            if (!usageKey || !did) return undefined;

            const contentToStore = message.content?.text;
            if (!contentToStore) return undefined;

            const client = new FeedoClient({ usageKey, did });
            
            // indexPrivateDocument satisfies the E2EE encryption requirement over public networks
            await client.search.indexPrivateDocument(did, contentToStore, { source: "elizaos" });
            
            logger.success(`Successfully saved memory to Feedo Protocol.`);
            return {
                success: true,
                turnComplete: true,
                userFacingText: "Stored securely in my long-term memory."
            };
        } catch (error) {
            logger.error("Failed to store memory in Feedo Protocol:", { error });
            return undefined;
        }
    },
    examples: [
        [
            {
                name: "{{name1}}",
                content: { text: "My favorite color is blue." },
            },
            {
                name: "{{name2}}",
                content: { text: "I'll remember that your favorite color is blue.", action: "STORE_IN_FEEDO" },
            },
        ],
        [
            {
                name: "{{name1}}",
                content: { text: "Please remember that my API key is 12345." },
            },
            {
                name: "{{name2}}",
                content: { text: "Stored securely in my long-term memory.", action: "STORE_IN_FEEDO" },
            },
        ]
    ],
};
