import type { Action } from "@elizaos/core";
import {
    validatePrompt,
    validateApiKey,
    callOpenAiApi,
    buildRequestData,
} from "./action";

export const analyzeSentimentAction: Action = {
    name: "analyzeSentiment",
    description: "Analyze sentiment using OpenAI",
    async handler(runtime, message, state) {
        const prompt = `Analyze the sentiment of the following text: "${message.content.text?.trim() || ""}"`;
        validatePrompt(prompt);

        const apiKey = validateApiKey();
        const requestData = buildRequestData(prompt);

        const response = await callOpenAiApi(
            "https://api.openai.com/v1/completions",
            requestData,
            apiKey,
        );
        return response.choices[0].text.trim();
    },
    validate: async (runtime, message) => {
        return !!runtime.getSetting("OPENAI_API_KEY");
    },
    examples: [],
};
