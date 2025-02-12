import {
    type Action,
    type ActionExample,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    logger
} from "@elizaos/core";

const twitterReplyAction = {
    name: "REPLY",
    similes: ["REPLY_TO_TWEET", "SEND_REPLY", "RESPOND", "ANSWER_TWEET"],
    description: "Replies to the current tweet with the text from the generated message. Default if the agent is responding with a message and no other action.",
    validate: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State
    ) => {
        // Only validate for Twitter messages
        if (message.content.source !== "twitter") {
            return false;
        }
        
        // Make sure we have the Twitter client available
        if (!state.twitterClient) {
            return false;
        }
        
        return true;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback,
        responses: Memory[]
    ) => {
        try {
            for (const response of responses) {
                // Call the callback to handle any additional processing
                await callback(response.content);
            }
        } catch (error) {
            logger.error("Error in Twitter reply action:", error);
            throw error;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "@agentName What do you think about the latest AI developments?",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "The rapid progress in AI is fascinating! I'm particularly excited about advances in multimodal models and their practical applications.",
                    action: "REPLY",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Hey @agentName, can you explain quantum computing?",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Let me explain quantum computing in simple terms! Instead of classical bits that are either 0 or 1, quantum computers use quantum bits that can exist in multiple states simultaneously.",
                    action: "REPLY",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "@agentName What's your favorite programming language?",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I love working with Python! The simplicity and readability make it perfect for both quick scripts and complex AI applications.",
                    action: "REPLY",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "@agentName Have you seen the latest research on transformer models?",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Yes! The improvements in efficiency and context length are really promising for advancing natural language understanding.",
                    action: "REPLY",
                },
            },
        ]
    ] as ActionExample[][]
} as Action;

export default twitterReplyAction;