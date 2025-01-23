import type { Action } from "@elizaos/core";
import {
    validatePrompt,
    validateApiKey,
    callOpenAiApi,
    buildRequestData,
} from "./action";

export const editTextAction: Action = {
    name: "editText",
    description: "Edit text using OpenAI",
    async handler(runtime, message, state) {
        const input = message.content.input?.trim() || "";
        const instruction = message.content.instruction?.trim() || "";
        validatePrompt(input);
        validatePrompt(instruction);

        const apiKey = validateApiKey();
        const requestData = {
            model: "text-davinci-edit-001",
            input,
            instruction,
        };

        const response = await callOpenAiApi(
            "https://api.openai.com/v1/edits",
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
