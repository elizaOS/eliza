/**
 * Tavily-backed `WebSearchService` — the `ServiceType.WEB_SEARCH` implementation.
 *
 * Wraps `@tavily/core` to fulfil the `IWebSearchService` contract (search /
 * news / images / videos / suggestions / trending / page-info), normalizing
 * Tavily's responses to core's shared shape. Degrades gracefully: without
 * `TAVILY_API_KEY` it boots inert and throws a descriptive error on first use
 * rather than crashing boot. `getPageInfo` is a raw fetch + regex scrape (not
 * Tavily-backed); videos reuse web search since Tavily has no video endpoint.
 */

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

function assertOptionalNonNegativeInteger(value: unknown, name: string): void {
    if (
        value !== undefined &&
        (typeof value !== "number" ||
            !Number.isFinite(value) ||
            !Number.isInteger(value) ||
            value < 0)
    ) {
        throw new Error(`${name} must be a non-negative finite integer`);
    }
}

function validateSearchOptions(options?: SearchOptions): void {
    if (options === undefined) return;
    if (!isRecord(options)) {
        throw new Error("search options must be an object");
    }
    assertOptionalPositiveInteger(options.limit, "limit");
    assertOptionalNonNegativeInteger(options.days, "days");
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
    if (options.includeAnswer !== undefined && typeof options.includeAnswer !== "boolean") {
        throw new Error("includeAnswer must be a boolean");
    }
    if (options.includeImages !== undefined && typeof options.includeImages !== "boolean") {
        throw new Error("includeImages must be a boolean");
    }
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
                typeof result.score === "number" && Number.isFinite(result.score)
                    ? result.score
                    : 0,
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

function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => {
            const num = Number(code);
            return Number.isFinite(num) ? String.fromCharCode(num) : _;
        })
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
            const num = parseInt(hex, 16);
            return Number.isFinite(num) ? String.fromCharCode(num) : _;
        });
}

function extractTitle(content: string, fallbackUrl: string): string {
    const match = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!match?.[1]) return fallbackUrl;
    const cleanText = match[1].replace(/<[^>]+>/g, "").trim();
    return cleanText ? decodeHtmlEntities(cleanText) : fallbackUrl;
}

function extractMetaTags(content: string): {
    description: string;
    metadata: Record<string, string>;
} {
    const metadata: Record<string, string> = {};
    let description = "";

    const metaRegex = /<meta\s+([^>]+)>/gi;
    let match = metaRegex.exec(content);
    while (match !== null) {
        const attrString = match[1];
        const keyMatch = attrString.match(/(?:name|property)=["']([^"']+)["']/i);
        const contentMatch = attrString.match(/content=["']([^"']*)["']/i);
        if (keyMatch && contentMatch) {
            const key = keyMatch[1].trim();
            const val = decodeHtmlEntities(contentMatch[1].trim());
            metadata[key] = val;
            const lowerKey = key.toLowerCase();
            if (
                !description &&
                (lowerKey === "description" ||
                    lowerKey === "og:description" ||
                    lowerKey === "twitter:description")
            ) {
                description = val;
            }
        }
        match = metaRegex.exec(content);
    }
    return { description, metadata };
}

function extractImages(content: string, baseUrl: URL): string[] {
    const images: string[] = [];
    const seen = new Set<string>();
    const imgRegex = /<img\s+[^>]*src=["']([^"']+)["']/gi;
    let match = imgRegex.exec(content);
    while (match !== null) {
        const rawSrc = match[1].trim();
        if (!rawSrc || rawSrc.startsWith("data:")) {
            match = imgRegex.exec(content);
            continue;
        }
        try {
            const resolved = new URL(rawSrc, baseUrl).toString();
            if (
                (resolved.startsWith("http://") || resolved.startsWith("https://")) &&
                !seen.has(resolved)
            ) {
                seen.add(resolved);
                images.push(resolved);
                if (images.length >= 20) break;
            }
        } catch {
            // Ignore malformed image URLs
        }
        match = imgRegex.exec(content);
    }
    return images;
}

function extractLinks(content: string, baseUrl: URL): string[] {
    const links: string[] = [];
    const seen = new Set<string>();
    const anchorRegex = /<a\s+[^>]*href=["']([^"']+)["']/gi;
    let match = anchorRegex.exec(content);
    while (match !== null) {
        const rawHref = match[1].trim();
        if (
            !rawHref ||
            rawHref.startsWith("#") ||
            rawHref.startsWith("javascript:") ||
            rawHref.startsWith("mailto:")
        ) {
            match = anchorRegex.exec(content);
            continue;
        }
        try {
            const resolved = new URL(rawHref, baseUrl).toString();
            if (
                (resolved.startsWith("http://") || resolved.startsWith("https://")) &&
                !seen.has(resolved)
            ) {
                seen.add(resolved);
                links.push(resolved);
                if (links.length >= 50) break;
            }
        } catch {
            // Ignore malformed hrefs
        }
        match = anchorRegex.exec(content);
    }
    return links;
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
        const apiKey = normalizeApiKey(runtime.getSetting("TAVILY_API_KEY"));
        if (!apiKey) {
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
        const normalizedQuery = validateSearchQuery(query);
        validateSearchOptions(options);
        if (!this.configured || !this.tavilyClient) {
            throw new Error("Web search is not configured: set TAVILY_API_KEY to enable it.");
        }
        try {
            const response = await this.tavilyClient.search(normalizedQuery, {
                includeAnswer: options?.includeAnswer ?? true,
                maxResults: options?.limit ?? 3,
                topic: options?.topic ?? options?.type ?? "general",
                searchDepth: options?.searchDepth ?? "basic",
                includeImages: options?.includeImages ?? false,
                days: options?.days ?? 3,
            });

            return normalizeResponse(normalizedQuery, response);
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
        const normalizedQuery = validateSearchQuery(query);
        return this.search(`${normalizedQuery} video`, {
            ...options,
            includeImages: true,
        });
    }

    async getSuggestions(query: string): Promise<string[]> {
        const response = await this.search(validateSearchQuery(query), {
            includeAnswer: false,
            limit: 5,
            searchDepth: "basic",
        });
        return uniqueResultTitles(response, 5);
    }

    async getTrendingSearches(region?: string): Promise<string[]> {
        const normalizedRegion = typeof region === "string" ? region.trim() : "";
        const query = normalizedRegion ? `trending news in ${normalizedRegion}` : "trending news";
        const response = await this.searchNews(query, {
            freshness: "day",
            limit: 5,
            region: normalizedRegion || undefined,
        });
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
        const title = extractTitle(content, url);
        const { description, metadata } = extractMetaTags(content);
        const images = extractImages(content, parsedUrl);
        const links = extractLinks(content, parsedUrl);
        return {
            title,
            description,
            content,
            metadata,
            images,
            links,
        };
    }
}
