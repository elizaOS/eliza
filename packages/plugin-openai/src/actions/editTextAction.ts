import type { Action } from "@elizaos/core";
import {
    validatePrompt,
    validateApiKey,
    callOpenAiApi,
} from "./action";

interface EditResponse {
    choices: Array<{ text: string }>;
}

export const editTextAction: Action = {
    name: "editText",
    description: "Edit text using OpenAI",
    similes: [],
    async handler(_runtime, message, _state) {
        const input = (message.content.input as string)?.trim() || "";
        const instruction = (message.content.instruction as string)?.trim() || "";
        validatePrompt(input);
        validatePrompt(instruction);

        const apiKey = validateApiKey();
        const requestData = {
            model: "text-davinci-edit-001",
            input,
            instruction,
            max_tokens: 1000,
            temperature: 0.7,
        };

        const response = await callOpenAiApi<EditResponse>(
            "https://api.openai.com/v1/edits",
            requestData,
            apiKey,
        );
        return response.choices[0].text.trim();
    },
    validate: async (runtime, _message) => {
        return !!runtime.getSetting("OPENAI_API_KEY");
    },
    examples: [],
};
