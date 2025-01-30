import type { Action } from "@elizaos/core";
import { 
    validateApiKey, 
    callOpenAiApi, 
    buildRequestData,
    type OpenAIRequestData
} from "./action";

export const transcribeAudioAction: Action = {
    name: "transcribeAudio",
    description: "Transcribe audio using OpenAI Whisper",
    similes: [],
    async handler(_runtime, message, _state) {
        const file = message.content.file;
        if (!file) {
            throw new Error("No audio file provided");
        }

        const apiKey = validateApiKey();
        const formData = new FormData();
        formData.append("file", file as Blob);
        formData.append("model", "whisper-1");

        interface TranscriptionResponse {
            text: string;
        }

        const response = await callOpenAiApi(
            "https://api.openai.com/v1/audio/transcriptions",
            formData as unknown as OpenAIRequestData,
            apiKey,
        ) as TranscriptionResponse;
        return response.text;
    },
    validate: async (runtime, _message) => {
        return !!runtime.getSetting("OPENAI_API_KEY");
    },
    examples: [],
};
