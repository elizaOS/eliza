/**
 * Local search option/result types for the SERPdive plugin, extending
 * `@elizaos/core`'s shared search types (`SearchOptions`/`SearchResponse`) and
 * re-exporting the image/news/video option types the service accepts. The
 * option shape deliberately matches plugin-web-search so call sites can swap
 * web-search providers without changing a line.
 */

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
    /**
     * Kept for drop-in compatibility with plugin-web-search: "basic" maps to
     * SERPdive's fast `mako` model, "advanced" to the full-page `moby` model.
     */
    searchDepth?: "basic" | "advanced";
    includeImages?: boolean;
    days?: number;
    /** SERPdive-native escape hatch; wins over `searchDepth` when set. */
    model?: "mako" | "moby";
}

export type { ImageSearchOptions, NewsSearchOptions, VideoSearchOptions };
