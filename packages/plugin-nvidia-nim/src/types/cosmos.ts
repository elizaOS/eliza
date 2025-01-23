import { Content } from "@elizaos/core";
import type { ChatCompletion } from "openai/resources/chat/completions";

export type MediaType = "img" | "video";

export interface MediaAsset {
    assetId: string;
    type: MediaType;
    mimeType: string;
    description?: string;
}

export interface CosmosAnalysis {
    description: string;
    confidence?: number;
}

export type CosmosResponse = ChatCompletion & {
    prompt_logprobs?: null;
};

export interface CosmosContent extends Content {
    text: string;
    mediaPath: string;
    success?: boolean;
    data?: {
        response?: string;
        analysis?: CosmosAnalysis;
        error?: string;
        raw?: CosmosResponse;
        asset?: MediaAsset;
    };
}