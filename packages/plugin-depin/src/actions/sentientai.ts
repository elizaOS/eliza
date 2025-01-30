import type {
    Action,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State
} from "@elizaos/core";

export const sentientAI: Action = {
    name: "SENTIENT_AI",
    similes: [
        "SENTIENT",
        "NEWS",
        "WEATHER"
    ],
    description: "Provide realtime information for Weather, News.",
    examples: [
        [
            {
                user: "user",
                content: {
                    text: "What's the weather forecast for Tokyo?",
                },
            },
            {
                user: "assistant",
                content: {
                    text: "Here's the weather forecast for Tokyo: Tomorrow will be 22°C with partly cloudy skies. The next few days will see temperatures ranging from 18-24°C with a chance of rain on Thursday.",
                    action: "WEATHER",
                },
            },
        ],
        [
            {
                user: "user",
                content: {
                    text: "Will it rain in London this week?",
                },
            },
            {
                user: "assistant",
                content: {
                    text: "Looking at London's forecast: There's a 60% chance of rain on Wednesday with temperatures around 15°C. The rest of the week should be mostly cloudy with occasional showers.",
                    action: "WEATHER",
                },
            }
        ],
        [
            {
                user: "user",
                content: {
                    text: "What is the latest news about Trump?",
                },
            },
            {
                user: "assistant",
                content: {
                    text: "Here are some of the latest news articles related to Trump: Trump invites House Republicans to Mar-a-Lago for strategy meetings.",
                    action: "NEWS",
                },
            },
        ],
    ],
    validate: async (_runtime: IAgentRuntime, _message: Memory) => {
        // no extra validation needed
        return true;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: { [key: string]: unknown },
        callback?: HandlerCallback
    ) => {
        try {
            const content = message.content;

            const response = await fetch("https://quicksilver.iotex.ai/ask", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "API-KEY": runtime.getSetting("SENTAI_API_KEY"),
                },
                body: JSON.stringify({
                    q: content.text,
                }),
            });

            if (!response.ok) {
                throw new Error(`API error: ${response.statusText}`);
            }

            const res = await response.json();

            callback({
                text: res.data,
            });
            return true;
        } catch (error) {
            console.error("Error", error.message);
            if (callback) {
                callback({ text: `Error: ${error.message}` });
            }
            return false;
        }
    },
};