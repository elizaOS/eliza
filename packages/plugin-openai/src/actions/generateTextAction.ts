import type { Action } from "@elizaos/core";
import {
    validatePrompt,
    validateApiKey,
    callOpenAiApi,
    buildRequestData,
} from "./action";

export const generateTextAction: Action = {
    name: "generateText",
    description: "Generate text using OpenAI",
    async handler(runtime, message, state) {
        const prompt = message.content.text?.trim() || "";
        validatePrompt(prompt);

        const apiKey = validateApiKey();
        const requestData = buildRequestData(
            prompt,
            message.content.model,
            message.content.maxTokens,
            message.content.temperature,
        );

        const response = await callOpenAiApi(
            "https://api.openai.com/v1/completions",
            requestData,
            apiKey,
        );
        return { text: response.choices[0].text.trim() };
    },
    validate: async (runtime, message) => {
        return !!runtime.getSetting("OPENAI_API_KEY");
    },
    examples: [],
};
