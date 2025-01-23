import { Content } from "@elizaos/core";
import type { ChatCompletion } from "openai/resources/chat/completions";

export interface OffTopicAnalysis {
    isOffTopic: boolean;
    confidence: number;
    reason?: string;
}

export type OffTopicResponse = ChatCompletion & {
    prompt_logprobs?: null;
};

export interface OffTopicContent extends Content {
    text: string;
    userMessage: string;
    success?: boolean;
    data?: {
        response?: string;
        analysis?: OffTopicAnalysis;
        error?: string;
        raw?: OffTopicResponse;
    };
}
