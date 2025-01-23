import { Content } from "@elizaos/core";
import type { ChatCompletion } from "openai/resources/chat/completions";

export interface SafetyAnalysis {
    "User Safety": "safe" | "unsafe";
    "Response Safety": "safe" | "unsafe";
    categories?: string[];
}

export type SafetyResponse = ChatCompletion & {
    prompt_logprobs?: null;
};

export interface SafetyContent extends Content {
    text: string;
    userMessage: string;
    assistantMessage?: string;
    success?: boolean;
    data?: {
        response?: string;
        analysis?: SafetyAnalysis;
        error?: string;
        raw?: SafetyResponse;
    };
}