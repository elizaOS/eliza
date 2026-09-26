/** Browser search options and complete profile-bound observation receipts. */

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

export type SearchResponse = {
    answer?: string;
    query: string;
    responseTime?: number;
    images: SearchImage[];
    results: SearchResult[];
    /** Exact user-authorized browser search session; absent for API providers. */
    browser?: { targetId: string; profileId: string; tabId: string; url: string };
};

export interface SearchOptions {
    offset?: number;
    limit?: number;
    type?: "news" | "general";
    topic?: "news" | "general";
    includeAnswer?: boolean;
    searchDepth?: "basic" | "advanced";
    includeImages?: boolean;
    days?: number;
}
