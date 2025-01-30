import type { Action } from "@elizaos/core";
import {
    validatePrompt,
    validateApiKey,
    callOpenAiApi,
    buildRequestData,
} from "./action";

export const generateEmbeddingAction: Action = {
    name: "generateEmbedding",
    description: "Generate embeddings using OpenAI",
    similes: [],
    async handler(_runtime, message, _state) {
        const input = (message.content.text as string)?.trim() || "";
        validatePrompt(input);

        const apiKey = validateApiKey();
        const requestData = buildRequestData(
            "text-embedding-ada-002",
            input
        );

        const response = await callOpenAiApi(
            "https://api.openai.com/v1/embeddings",
            requestData,
            apiKey,
        ) as { data: Array<{ embedding: number[] }> };
        return response.data.map((item: { embedding: number[] }) => item.embedding);
    },
    validate: async (runtime, _message) => {
        return !!runtime.getSetting("OPENAI_API_KEY");
    },
    examples: [],
};
