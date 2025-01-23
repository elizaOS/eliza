import type { Action } from "@elizaos/core";
import { validatePrompt, validateApiKey, callOpenAiApi } from "./action";

export const moderateContentAction: Action = {
    name: "moderateContent",
    description: "Moderate content using OpenAI",
    async handler(runtime, message, state) {
        const input = message.content.text?.trim() || "";
        validatePrompt(input);

        const apiKey = validateApiKey();
        const requestData = { input };

        const response = await callOpenAiApi(
            "https://api.openai.com/v1/moderations",
            requestData,
            apiKey,
        );
        return response.results;
    },
    validate: async (runtime, message) => {
        return !!runtime.getSetting("OPENAI_API_KEY");
    },
    examples: [],
};
