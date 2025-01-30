import type {
    ActionExample,
    IAgentRuntime,
    Memory,
    Action,
} from "@elizaos/core";

export const ignoreAction: Action = {
    name: "IGNORE",
    similes: ["STOP_TALKING", "STOP_CHATTING", "STOP_CONVERSATION"],
    validate: async (_runtime: IAgentRuntime, _message: Memory) => {
        return true;
    },
    description:
        "Call this action if ignoring the user. If the user is aggressive, creepy or is finished with the conversation, use this action. Or, if both you and the user have already said goodbye, use this action instead of saying bye again. Use IGNORE any time the conversation has naturally ended. Do not use IGNORE if the user has engaged directly, or if something went wrong an you need to tell them. Only ignore if the user should be ignored.",
    handler: async (
        _runtime: IAgentRuntime,
        _message: Memory,
    ): Promise<boolean> => {
        return true;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Go screw yourself" },
            },
            {
                user: "{{user2}}",
                content: { text: "", action: "IGNORE" },
            },
        ],

        [
            {
                user: "{{user1}}",
                content: { text: "Shut up, bot" },
            },
            {
                user: "{{user2}}",
                content: { text: "", action: "IGNORE" },
            },
        ],

        [
            {
                user: "{{user1}}",
                content: { text: "Got any investment advice" },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Uh, don’t let the volatility sway your long-term strategy",
                },
            },
            {
                user: "{{user1}}",
                content: { text: "Wise words I think" },
            },
            {
                user: "{{user1}}",
                content: { text: "I gotta run, talk to you later" },
            },
            {
                user: "{{user2}}",
                content: { text: "See ya" },
            },
            { user: "{{user1}}", content: { text: "" }, action: "IGNORE" },
        ],

        [
            {
                user: "{{user1}}",
                content: { text: "Gotta go" },
            },
            {
                user: "{{user2}}",
                content: { text: "Okay, talk to you later" },
            },
            {
                user: "{{user1}}",
                content: { text: "Cya" },
            },
            {
                user: "{{user2}}",
                content: { text: "", action: "IGNORE" },
            },
        ],

        [
            {
                user: "{{user1}}",
                content: { text: "bye" },
            },
            {
                user: "{{user2}}",
                content: { text: "cya" },
            },
            {
                user: "{{user1}}",
                content: { text: "", action: "IGNORE" },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Who added this stupid bot to the chat",
                },
            },
            {
                user: "{{user2}}",
                content: { text: "Sorry, am I being annoying" },
            },
            {
                user: "{{user1}}",
                content: { text: "Yeah", action: "CONTINUE" },
            },
            {
                user: "{{user1}}",
                content: { text: "PLEASE shut up" },
            },
            { user: "{{user2}}", content: { text: "", action: "IGNORE" } },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "ur so dumb",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "",
                    action: "IGNORE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "later nerd",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "bye",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "",
                    action: "IGNORE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "wanna cyber",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "thats inappropriate",
                    action: "IGNORE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Im out ttyl",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "cya",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "",
                    action: "IGNORE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "u there",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "yes how can I help",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "k nvm figured it out",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "",
                    action: "IGNORE",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
