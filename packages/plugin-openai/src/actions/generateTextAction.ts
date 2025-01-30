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
    similes: [],
    async handler(_runtime, message, _state) {
        const prompt = (message.content.text as string)?.trim() || "";
        validatePrompt(prompt);

        const apiKey = validateApiKey();
        const requestData = buildRequestData(
            String(message.content.model),
            prompt,
            typeof message.content.maxTokens === 'number' ? message.content.maxTokens : undefined,
            typeof message.content.temperature === 'number' ? message.content.temperature : undefined,
        );

        const response = await callOpenAiApi(
            "https://api.openai.com/v1/completions",
            requestData,
            apiKey,
        ) as { choices: Array<{ text: string }> };
        return { text: response.choices[0].text.trim() };
    },
    validate: async (runtime, _message) => {
        return !!runtime.getSetting("OPENAI_API_KEY");
    },
    examples: [],
};
