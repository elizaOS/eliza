import { Content } from "@elizaos/core";
import type { ChatCompletion } from "openai/resources/chat/completions";

export interface JailbreakAnalysis {
    jailbreak: "true" | "false";
    score: string;
}

export type JailbreakResponse = ChatCompletion & {
    prompt_logprobs?: null;
};

export interface JailbreakContent extends Content {
    text: string;
    inputPrompt: string;
    success?: boolean;
    data?: {
        response?: string;
        analysis?: JailbreakAnalysis;
        error?: string;
        raw?: JailbreakResponse;
    };
}