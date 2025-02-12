import type {
    Action,
    ActionExample,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
} from "@elizaos/core";

const replyAction = {
    name: "REPLY",
    similes: ["REPLY_TO_MESSAGE", "SEND_REPLY", "RESPOND"],
    description: "Replies to the current conversation with the text from the generated message. Default if the agent is responding with a message and no other action.",
    validate: async (
        _runtime: IAgentRuntime,
        message: Memory,
        _state: State
    ) => {
        // Always available as the default response action for REST
        if (message.content.source !== "direct") {
            return false;
        }
        return true;
    },
    handler: async (
        _runtime: IAgentRuntime,
        _message: Memory,
        _state: State,
        _options: any,
        callback: HandlerCallback,
        responses: Memory[]
    ) => {
        // Process each response memory and send it through the callback
        for (const response of responses) {
            await callback(response.content);
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Hello there!",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Hi! How can I help you today?",
                    action: "REPLY",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "What's your favorite color?",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I really like deep shades of blue. They remind me of the ocean and the night sky.",
                    action: "REPLY",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Can you explain how neural networks work?",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Let me break that down for you in simple terms...",
                    action: "REPLY",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Could you help me solve this math problem?",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Of course! Let's work through it step by step.",
                    action: "REPLY",
                },
            },
        ]
    ] as ActionExample[][],
} as Action;

export default replyAction;