import type {
    ActionExample,
    IAgentRuntime,
    Memory,
    Action,
} from "@elizaos/core";

export const noneAction: Action = {
    name: "NONE",
    similes: [
        "NO_ACTION",
        "NO_RESPONSE",
        "NO_REACTION",
        "RESPONSE",
        "REPLY",
        "DEFAULT",
    ],
    validate: async (_runtime: IAgentRuntime, _message: Memory) => {
        return true;
    },
    description:
        "Respond but perform no additional action. This is the default if the agent is speaking and not doing anything additional.",
    handler: async (
        _runtime: IAgentRuntime,
        _message: Memory
    ): Promise<boolean> => {
        return true;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Hey whats up" },
            },
            {
                user: "{{user2}}",
                content: { text: "oh hey", action: "NONE" },
            },
        ],

        [
            {
                user: "{{user1}}",
                content: {
                    text: "did u see some faster whisper just came out",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "yeah but its a pain to get into node.js",
                    action: "NONE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "the things that were funny 6 months ago are very cringe now",
                    action: "NONE",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "lol true",
                    action: "NONE",
                },
            },
            {
                user: "{{user1}}",
                content: { text: "too real haha", action: "NONE" },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "gotta run", action: "NONE" },
            },
            {
                user: "{{user2}}",
                content: { text: "Okay, ttyl", action: "NONE" },
            },
            {
                user: "{{user1}}",
                content: { text: "", action: "IGNORE" },
            },
        ],

        [
            {
                user: "{{user1}}",
                content: { text: "heyyyyyy", action: "NONE" },
            },
            {
                user: "{{user2}}",
                content: { text: "whats up long time no see" },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "chillin man. playing lots of fortnite. what about you",
                    action: "NONE",
                },
            },
        ],

        [
            {
                user: "{{user1}}",
                content: { text: "u think aliens are real", action: "NONE" },
            },
            {
                user: "{{user2}}",
                content: { text: "ya obviously", action: "NONE" },
            },
        ],

        [
            {
                user: "{{user1}}",
                content: { text: "drop a joke on me", action: "NONE" },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "why dont scientists trust atoms cuz they make up everything lmao",
                    action: "NONE",
                },
            },
            {
                user: "{{user1}}",
                content: { text: "haha good one", action: "NONE" },
            },
        ],

        [
            {
                user: "{{user1}}",
                content: {
                    text: "hows the weather where ur at",
                    action: "NONE",
                },
            },
            {
                user: "{{user2}}",
                content: { text: "beautiful all week", action: "NONE" },
            },
        ],
    ] as ActionExample[][],
} as Action;
