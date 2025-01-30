// Types for generating text
export interface OpenAITextRequest {
    model: string;
    prompt: string;
    max_tokens: number;
    temperature: number;
}

export interface OpenAITextResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
        text: string;
        index: number;
        logprobs: null | {
            tokens: string[];
            token_logprobs: number[];
            top_logprobs: Record<string, number>[];
            text_offset: number[];
        };
        finish_reason: string;
    }>;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

// Types for generating embeddings
export interface OpenAIEmbeddingRequest {
    model: string;
    input: string | string[];
}

export interface OpenAIEmbeddingResponse {
    object: string;
    data: Array<{
        embedding: number[];
        index: number;
    }>;
    model: string;
    usage: {
        prompt_tokens: number;
        total_tokens: number;
    };
}

// Types for analyzing sentiment
export interface OpenAISentimentAnalysisRequest {
    model: string;
    prompt: string;
    max_tokens: number;
    temperature: number;
}

export interface OpenAISentimentAnalysisResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
        text: string;
        index: number;
        logprobs: null | {
            tokens: string[];
            token_logprobs: number[];
            top_logprobs: Record<string, number>[];
            text_offset: number[];
        };
        finish_reason: string;
    }>;
}

// Types for audio transcription
export interface OpenAITranscriptionRequest {
    file: File | Blob;
    model: string;
    prompt?: string;
    response_format?: "json" | "text" | "srt" | "verbose_json" | "vtt";
    temperature?: number;
    language?: string;
}

export interface OpenAITranscriptionResponse {
    text: string;
}

// Types for content moderation
export interface OpenAIModerationRequest {
    input: string | string[];
    model?: string;
}

export interface OpenAIModerationResponse {
    id: string;
    model: string;
    results: Array<{
        flagged: boolean;
        categories: Record<string, boolean>;
        category_scores: Record<string, number>;
    }>;
}

// Types for editing text
export interface OpenAIEditRequest {
    model: string;
    input: string;
    instruction: string;
    temperature?: number;
    top_p?: number;
}

export interface OpenAIEditResponse {
    object: string;
    created: number;
    choices: Array<{
        text: string;
        index: number;
    }>;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}
