import { type IAgentRuntime, IWebSearchService, logger, ServiceType } from "@elizaos/core";
import { tavily } from "@tavily/core";

import type {
    ImageSearchOptions,
    NewsSearchOptions,
    SearchOptions,
    SearchResponse,
    VideoSearchOptions,
} from "../types";

export type TavilyClient = ReturnType<typeof tavily>;

type TavilySearchResult = {
    title?: string;
    url?: string;
    content?: string;
    rawContent?: string;
    score?: number;
    publishedDate?: string;
};

type TavilySearchResponse = {
    answer?: string;
    query?: string;
    responseTime?: number;
    images?: Array<{ url?: string; description?: string } | string>;
    results?: TavilySearchResult[];
};

function parsePublishedDate(value: string | undefined): Date | undefined {
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
}

function normalizeResponse(query: string, response: TavilySearchResponse): SearchResponse {
    const results = (response.results ?? []).map((result) => {
        const content = result.content ?? "";
        return {
            title: result.title ?? "Untitled",
            url: result.url ?? "",
            description: content,
            content,
            rawContent: result.rawContent,
            score: typeof result.score === "number" ? result.score : 0,
            publishedDate: parsePublishedDate(result.publishedDate),
        };
    });
    const images = (response.images ?? [])
        .map((image) =>
            typeof image === "string"
                ? { url: image }
                : { url: image.url ?? "", description: image.description }
        )
        .filter((image) => image.url);

    return {
        answer: response.answer,
        query: response.query ?? query,
        responseTime: response.responseTime,
        images,
        results,
    };
}

function freshnessToDays(freshness: NewsSearchOptions["freshness"]): number {
    switch (freshness) {
        case "day":
            return 1;
        case "week":
            return 7;
        case "month":
            return 30;
        default:
            return 3;
    }
}

export class WebSearchService extends IWebSearchService {
    static override serviceType = ServiceType.WEB_SEARCH;
    override capabilityDescription = "Web search and content discovery capabilities" as const;

    tavilyClient!: TavilyClient;

    static override async start(runtime: IAgentRuntime): Promise<WebSearchService> {
        const service = new WebSearchService(runtime);
        await service.initialize(runtime);
        return service;
    }

    async stop(): Promise<void> {
        // Tavily client is stateless HTTP; nothing to tear down.
    }

    private async initialize(runtime: IAgentRuntime): Promise<void> {
        const apiKey = runtime.getSetting("TAVILY_API_KEY");
        if (typeof apiKey !== "string" || apiKey.length === 0) {
            throw new Error("TAVILY_API_KEY is not set");
        }
        this.tavilyClient = tavily({ apiKey });
    }

    async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
        try {
            const response = await this.tavilyClient.search(query, {
                includeAnswer: options?.includeAnswer ?? true,
                maxResults: options?.limit ?? 3,
                topic: options?.topic ?? options?.type ?? "general",
                searchDepth: options?.searchDepth ?? "basic",
                includeImages: options?.includeImages ?? false,
                days: options?.days ?? 3,
            });

            return normalizeResponse(query, response as TavilySearchResponse);
        } catch (cause) {
            const err = cause instanceof Error ? cause : new Error(String(cause));
            logger.error({ src: "plugin-web-search", err }, "Web search error");
            throw err;
        }
    }

    async searchNews(query: string, options?: NewsSearchOptions): Promise<SearchResponse> {
        return this.search(query, {
            ...options,
            type: "news",
            topic: "news",
            days: freshnessToDays(options?.freshness),
        });
    }

    async searchImages(query: string, options?: ImageSearchOptions): Promise<SearchResponse> {
        return this.search(query, {
            limit: options?.limit,
            offset: options?.offset,
            language: options?.language,
            region: options?.region,
            dateRange: options?.dateRange,
            fileType: options?.fileType,
            site: options?.site,
            sortBy: options?.sortBy,
            safeSearch: options?.safeSearch,
            includeImages: true,
        });
    }

    async searchVideos(query: string, options?: VideoSearchOptions): Promise<SearchResponse> {
        return this.search(query, options);
    }

    async getSuggestions(_query: string): Promise<string[]> {
        return [];
    }

    async getTrendingSearches(_region?: string): Promise<string[]> {
        return [];
    }

    async getPageInfo(url: string): Promise<{
        title: string;
        description: string;
        content: string;
        metadata: Record<string, string>;
        images: string[];
        links: string[];
    }> {
        const response = await fetch(url);
        const content = await response.text();
        const title = content.match(/<title[^>]*>(.*?)<\/title>/i)?.[1] ?? url;
        const description =
            content.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)/i)?.[1] ?? "";
        return {
            title,
            description,
            content,
            metadata: {},
            images: [],
            links: [],
        };
    }
}
