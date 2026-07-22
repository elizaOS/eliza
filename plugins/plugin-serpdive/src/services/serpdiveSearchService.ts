/**
 * SERPdive-backed `SerpdiveSearchService` — a `ServiceType.WEB_SEARCH`
 * implementation.
 *
 * Wraps the zero-dependency `serpdive` SDK to fulfil the `IWebSearchService`
 * contract (search / news / images / videos / suggestions / trending /
 * page-info). SERPdive returns extracted, answer-ready page content instead of
 * links, so `content` carries the actual text of each page. Degrades
 * gracefully: without `SERPDIVE_API_KEY` it boots inert and throws a
 * descriptive error on first use rather than crashing boot.
 *
 * Mapping notes, kept deliberately honest:
 * - `searchDepth` maps to SERPdive's models: "basic" → `mako` (fact-carrying
 *   sentences, fast), "advanced" → `moby` (full page text). A native `model`
 *   option wins when provided.
 * - News search is plain search: SERPdive infers freshness and locale from
 *   the query itself; there is no separate news endpoint or recency knob, so
 *   `days`/`freshness` are accepted for compatibility and not forwarded.
 * - SERPdive returns no images, so image/video search reuse web search and
 *   `images` stays empty — results are never fabricated.
 * - `getPageInfo` is a raw fetch + regex scrape (not SERPdive-backed), same
 *   as plugin-web-search.
 */

import { type IAgentRuntime, IWebSearchService, logger, ServiceType } from "@elizaos/core";
import { SerpDive } from "serpdive";

import type {
    ImageSearchOptions,
    NewsSearchOptions,
    SearchOptions,
    SearchResponse,
    VideoSearchOptions,
} from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsePublishedDate(value: string | undefined): Date | undefined {
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
}

function normalizeApiKey(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validateSearchQuery(query: unknown): string {
    if (typeof query !== "string" || !query.trim()) {
        throw new Error("search query is required");
    }
    return query.trim();
}

function assertOptionalPositiveInteger(value: unknown, name: string): void {
    if (
        value !== undefined &&
        (typeof value !== "number" ||
            !Number.isFinite(value) ||
            !Number.isInteger(value) ||
            value < 1)
    ) {
        throw new Error(`${name} must be a positive finite integer`);
    }
}

function validateSearchOptions(options?: SearchOptions): void {
    if (options === undefined) return;
    if (!isRecord(options)) {
        throw new Error("search options must be an object");
    }
    assertOptionalPositiveInteger(options.limit, "limit");
    if (options.topic !== undefined && options.topic !== "general" && options.topic !== "news") {
        throw new Error("topic must be general or news");
    }
    if (options.type !== undefined && options.type !== "general" && options.type !== "news") {
        throw new Error("type must be general or news");
    }
    if (
        options.searchDepth !== undefined &&
        options.searchDepth !== "basic" &&
        options.searchDepth !== "advanced"
    ) {
        throw new Error("searchDepth must be basic or advanced");
    }
    if (options.model !== undefined && options.model !== "mako" && options.model !== "moby") {
        throw new Error("model must be mako or moby");
    }
    if (options.includeAnswer !== undefined && typeof options.includeAnswer !== "boolean") {
        throw new Error("includeAnswer must be a boolean");
    }
}

function pickModel(options?: SearchOptions): "mako" | "moby" {
    if (options?.model) return options.model;
    return options?.searchDepth === "advanced" ? "moby" : "mako";
}

function normalizeResponse(query: string, response: unknown): SearchResponse {
    const payload = isRecord(response) ? response : {};
    const rawResults = Array.isArray(payload.results) ? payload.results : [];
    const results = rawResults.filter(isRecord).map((result) => {
        const content = typeof result.content === "string" ? result.content : "";
        return {
            title: typeof result.title === "string" && result.title ? result.title : "Untitled",
            url: typeof result.url === "string" ? result.url : "",
            description: content,
            content,
            rawContent: undefined,
            // SERPdive orders results best-first but publishes no per-result
            // score; 0 mirrors plugin-web-search's default for absent scores.
            score: 0,
            publishedDate: parsePublishedDate(
                typeof result.date === "string" ? result.date : undefined
            ),
        };
    });

    return {
        answer: typeof payload.answer === "string" ? payload.answer : undefined,
        query: typeof payload.query === "string" ? payload.query : query,
        // The API reports milliseconds; core consumers expect Tavily-style
        // seconds, so convert.
        responseTime:
            typeof payload.response_time_ms === "number" &&
            Number.isFinite(payload.response_time_ms)
                ? payload.response_time_ms / 1000
                : undefined,
        images: [],
        results,
    };
}

function uniqueResultTitles(response: SearchResponse, limit: number): string[] {
    const seen = new Set<string>();
    const titles: string[] = [];
    for (const result of response.results) {
        const title = result.title.trim();
        if (!title || title === "Untitled") continue;
        const key = title.toLocaleLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        titles.push(title);
        if (titles.length >= limit) break;
    }
    return titles;
}

export class SerpdiveSearchService extends IWebSearchService {
    static override serviceType = ServiceType.WEB_SEARCH;
    override capabilityDescription = "Web search and content discovery capabilities" as const;

    serpdiveClient: SerpDive | undefined;
    private configured = false;

    static override async start(runtime: IAgentRuntime): Promise<SerpdiveSearchService> {
        const service = new SerpdiveSearchService(runtime);
        await service.initialize(runtime);
        return service;
    }

    async stop(): Promise<void> {
        // The SERPdive client is stateless HTTP; nothing to tear down.
    }

    private async initialize(runtime: IAgentRuntime): Promise<void> {
        const apiKey = normalizeApiKey(runtime.getSetting("SERPDIVE_API_KEY"));
        if (!apiKey) {
            // Degrade gracefully instead of throwing, so the plugin can be
            // installed unconfigured without crashing agent boot. The service
            // stays inert and `search()` reports an honest, recoverable error
            // until a SERPDIVE_API_KEY is provided.
            this.configured = false;
            logger.warn(
                { src: "plugin-serpdive" },
                "SERPDIVE_API_KEY not set — web search is inert until a key is provided"
            );
            return;
        }
        this.serpdiveClient = new SerpDive({ apiKey });
        this.configured = true;
    }

    async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
        const normalizedQuery = validateSearchQuery(query);
        validateSearchOptions(options);
        if (!this.configured || !this.serpdiveClient) {
            throw new Error("Web search is not configured: set SERPDIVE_API_KEY to enable it.");
        }
        try {
            const response = await this.serpdiveClient.search(normalizedQuery, {
                model: pickModel(options),
                answer: options?.includeAnswer ?? true,
                ...(options?.limit !== undefined ? { maxResults: options.limit } : {}),
            });

            // The JS SDK returns the API payload verbatim (snake_case fields
            // included), so it can be normalized directly.
            return normalizeResponse(normalizedQuery, response);
        } catch (cause) {
            const err = cause instanceof Error ? cause : new Error(String(cause));
            logger.error({ src: "plugin-serpdive", err }, "Web search error");
            throw err;
        }
    }

    async searchNews(query: string, options?: NewsSearchOptions): Promise<SearchResponse> {
        // SERPdive infers freshness from the query itself; `freshness` is
        // accepted for provider compatibility but has no knob to forward.
        return this.search(query, {
            limit: options?.limit,
        });
    }

    async searchImages(query: string, options?: ImageSearchOptions): Promise<SearchResponse> {
        // No image endpoint: reuse web search. `images` stays empty rather
        // than fabricating entries.
        return this.search(validateSearchQuery(query), {
            limit: options?.limit,
        });
    }

    async searchVideos(query: string, options?: VideoSearchOptions): Promise<SearchResponse> {
        // Same approach as plugin-web-search: no video endpoint, bias the
        // query and reuse web search.
        const normalizedQuery = validateSearchQuery(query);
        return this.search(`${normalizedQuery} video`, {
            limit: options?.limit,
        });
    }

    async getSuggestions(query: string): Promise<string[]> {
        const response = await this.search(validateSearchQuery(query), {
            includeAnswer: false,
            limit: 5,
        });
        return uniqueResultTitles(response, 5);
    }

    async getTrendingSearches(region?: string): Promise<string[]> {
        const normalizedRegion = typeof region === "string" ? region.trim() : "";
        const query = normalizedRegion ? `trending news in ${normalizedRegion}` : "trending news";
        const response = await this.searchNews(query, { limit: 5 });
        return uniqueResultTitles(response, 5);
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
