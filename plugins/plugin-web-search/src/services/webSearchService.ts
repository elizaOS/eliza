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

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsePublishedDate(value: string | undefined): Date | undefined {
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
}

function normalizeResponse(query: string, response: unknown): SearchResponse {
    const payload = isRecord(response) ? response : {};
    const rawResults = Array.isArray(payload.results) ? payload.results : [];
    const results = rawResults.filter(isRecord).map((result) => {
        const content = typeof result.content === "string" ? result.content : "";
        return {
            title: typeof result.title === "string" ? result.title : "Untitled",
            url: typeof result.url === "string" ? result.url : "",
            description: content,
            content,
            rawContent: typeof result.rawContent === "string" ? result.rawContent : undefined,
            score:
                typeof result.score === "number" && Number.isFinite(result.score) ? result.score : 0,
            publishedDate: parsePublishedDate(
                typeof result.publishedDate === "string" ? result.publishedDate : undefined
            ),
        };
    });
    const rawImages = Array.isArray(payload.images) ? payload.images : [];
    const images = rawImages
        .map((image) =>
            typeof image === "string"
                ? { url: image }
                : isRecord(image)
                  ? {
                        url: typeof image.url === "string" ? image.url : "",
                        description:
                            typeof image.description === "string" ? image.description : undefined,
                    }
                  : { url: "" }
        )
        .filter((image) => image.url);

    return {
        answer: typeof payload.answer === "string" ? payload.answer : undefined,
        query: typeof payload.query === "string" ? payload.query : query,
        responseTime: typeof payload.responseTime === "number" ? payload.responseTime : undefined,
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

    tavilyClient: TavilyClient | undefined;
    private configured = false;

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
            // Degrade gracefully instead of throwing, so the plugin can be
            // installed unconfigured without crashing agent boot. The service
            // stays inert and `search()` reports an honest, recoverable error
            // until a TAVILY_API_KEY is provided.
            this.configured = false;
            logger.warn(
                { src: "plugin-web-search" },
                "TAVILY_API_KEY not set — web search is inert until a key is provided"
            );
            return;
        }
        this.tavilyClient = tavily({ apiKey });
        this.configured = true;
    }

    async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
        if (!this.configured || !this.tavilyClient) {
            throw new Error("Web search is not configured: set TAVILY_API_KEY to enable it.");
        }
        try {
            const response = await this.tavilyClient.search(query, {
                includeAnswer: options?.includeAnswer ?? true,
                maxResults: options?.limit ?? 3,
                topic: options?.topic ?? options?.type ?? "general",
                searchDepth: options?.searchDepth ?? "basic",
                includeImages: options?.includeImages ?? false,
                days: options?.days ?? 3,
            });

            return normalizeResponse(query, response);
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
        let parsedUrl: URL;
        try {
            parsedUrl = new URL(url);
        } catch {
            throw new Error("Invalid page info URL");
        }
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
            throw new Error("Page info URL must use http or https");
        }

        const response = await fetch(parsedUrl.toString());
        if (!response.ok) {
            throw new Error(`Failed to fetch page info: ${response.status} ${response.statusText}`);
        }
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
