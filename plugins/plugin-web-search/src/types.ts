import type {
    SearchOptions as CoreSearchOptions,
    SearchResponse as CoreSearchResponse,
    ImageSearchOptions,
    NewsSearchOptions,
    VideoSearchOptions,
} from "@elizaos/core";

export type SearchResult = {
    title: string;
    url: string;
    description: string;
    content: string;
    rawContent?: string;
    score: number;
    publishedDate?: Date;
};

export type SearchImage = {
    url: string;
    description?: string;
};

export type SearchResponse = Omit<CoreSearchResponse, "results"> & {
    answer?: string;
    query: string;
    responseTime?: number;
    images: SearchImage[];
    results: SearchResult[];
};

export interface SearchOptions extends CoreSearchOptions {
    limit?: number;
    type?: "news" | "general";
    topic?: "news" | "general";
    includeAnswer?: boolean;
    searchDepth?: "basic" | "advanced";
    includeImages?: boolean;
    days?: number;
}

export type { ImageSearchOptions, NewsSearchOptions, VideoSearchOptions };
