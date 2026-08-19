/**
 * Tavily-backed `WebSearchService` — the `ServiceType.WEB_SEARCH` implementation.
 *
 * Wraps `@tavily/core` to fulfil the `IWebSearchService` contract (search /
 * news / images / videos / suggestions / trending / page-info), normalizing
 * Tavily's responses to core's shared shape. Degrades gracefully: without
 * `TAVILY_API_KEY` it boots inert and throws a descriptive error on first use
 * rather than crashing boot. `getPageInfo` scrapes title, description, meta
 * tags, images, and links from untrusted HTML; the page bytes are always
 * fetched through `fetchWithSsrfGuard` so private / loopback / link-local
 * targets fail closed, redirect hops are revalidated, and response bodies are
 * streamed through a byte cap before parsing. Videos reuse web search since
 * Tavily has no video endpoint.
 */

import {
    ElizaError,
    fetchWithSsrfGuard,
    type IAgentRuntime,
    IWebSearchService,
    logger,
    ServiceType,
} from "@elizaos/core";
import { tavily } from "@tavily/core";

import type {
    ImageSearchOptions,
    NewsSearchOptions,
    SearchOptions,
    SearchResponse,
    VideoSearchOptions,
} from "../types";

export type TavilyClient = ReturnType<typeof tavily>;

/** Bound how long a remote page-info endpoint may hang the action. */
const PAGE_INFO_HTTP_TIMEOUT_MS = 15_000;
/** Cap redirect hops so a hostile chain cannot spin the guard forever. */
const PAGE_INFO_HTTP_MAX_REDIRECTS = 5;
/** Bound untrusted page HTML before it reaches the regex extraction layer. */
const PAGE_INFO_MAX_HTML_BYTES = 1024 * 1024;

/**
 * Deterministic-test seam for the SSRF-guarded page-info transport.
 * Production leaves this unset so the guard uses Node-pinned defaults.
 */
export type PageInfoHttpTransport = Pick<
    Parameters<typeof fetchWithSsrfGuard>[0],
    "fetchImpl" | "lookupFn" | "pinnedFetchImpl"
>;

let pageInfoHttpTransportOverride: PageInfoHttpTransport | undefined;

/**
 * Override the SSRF-guarded HTTP transport used by {@link WebSearchService.getPageInfo}.
 * Intended for unit tests only; production must leave this unset.
 */
export function setPageInfoHttpTransportForTests(
    transport: PageInfoHttpTransport | undefined
): void {
    pageInfoHttpTransportOverride = transport;
}

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
    const decodeNumericEntity = (entity: string, digits: string, radix: number): string => {
        const codePoint = Number.parseInt(digits, radix);
        if (
            !Number.isSafeInteger(codePoint) ||
            codePoint <= 0 ||
            codePoint > 0x10ffff ||
            (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
            return entity;
        }
        return String.fromCodePoint(codePoint);
    };

    return text
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (entity, digits: string) => decodeNumericEntity(entity, digits, 10))
        .replace(/&#x([0-9a-fA-F]+);/g, (entity, digits: string) =>
            decodeNumericEntity(entity, digits, 16)
        );
}

type PageBodyCanceller = {
    cancel(reason?: unknown): Promise<void>;
};

function pageInfoTooLargeError(cause?: unknown): ElizaError {
    return new ElizaError("Page info HTML exceeds the response-size limit.", {
        code: "PAGE_INFO_HTML_TOO_LARGE",
        context: { limit: PAGE_INFO_MAX_HTML_BYTES },
        cause,
        severity: "fatal",
    });
}

async function rejectOversizePageHtml(canceller?: PageBodyCanceller): Promise<never> {
    if (canceller) {
        try {
            await canceller.cancel("page info HTML exceeded size limit");
        } catch (cause) {
            // error-policy:J2 Keep the size violation authoritative while
            // preserving a transport cancellation failure for diagnostics.
            throw pageInfoTooLargeError(cause);
        }
    }
    throw pageInfoTooLargeError();
}

async function readBoundedPageHtml(response: Response): Promise<string> {
    const declaredLength = response.headers.get("content-length");
    if (
        declaredLength &&
        /^\d+$/.test(declaredLength) &&
        Number(declaredLength) > PAGE_INFO_MAX_HTML_BYTES
    ) {
        return rejectOversizePageHtml(response.body ?? undefined);
    }
    if (!response.body) {
        throw new ElizaError("Page info response has no body.", {
            code: "PAGE_INFO_BODY_MISSING",
            severity: "fatal",
        });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let byteLength = 0;
    let content = "";

    try {
        while (true) {
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
                chunk = await reader.read();
            } catch (cause) {
                // error-policy:J2 Preserve the transport failure while naming
                // the page-info boundary that could not finish reading.
                throw new ElizaError("Page info response body read failed.", {
                    code: "PAGE_INFO_BODY_READ_FAILED",
                    cause,
                    severity: "ephemeral",
                });
            }
            if (chunk.done) break;
            byteLength += chunk.value.byteLength;
            if (byteLength > PAGE_INFO_MAX_HTML_BYTES) {
                return rejectOversizePageHtml(reader);
            }
            content += decoder.decode(chunk.value, { stream: true });
        }
        content += decoder.decode();
        return content;
    } finally {
        reader.releaseLock();
    }
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

function resolveHttpUrl(raw: string, baseUrl: URL): string | null {
    try {
        const resolved = new URL(raw, baseUrl);
        if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
            return null;
        }
        return resolved.toString();
    } catch {
        // error-policy:J3 untrusted HTML may contain unparseable URL candidates
        return null;
    }
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
        const resolved = resolveHttpUrl(rawSrc, baseUrl);
        if (resolved && !seen.has(resolved)) {
            seen.add(resolved);
            images.push(resolved);
            if (images.length >= 20) break;
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
        const resolved = resolveHttpUrl(rawHref, baseUrl);
        if (resolved && !seen.has(resolved)) {
            seen.add(resolved);
            links.push(resolved);
            if (links.length >= 50) break;
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
            days:
                options?.days ??
                (options?.freshness ? freshnessToDays(options.freshness) : undefined),
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
            // error-policy:J3 invalid caller URL is an explicit input failure
            throw new Error("Invalid page info URL");
        }
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
            throw new Error("Page info URL must use http or https");
        }

        // Caller-supplied page URLs are untrusted; never use raw fetch with
        // automatic redirect following. The shared guard blocks private /
        // loopback / link-local targets and revalidates every redirect hop.
        const guarded = await fetchWithSsrfGuard({
            url: parsedUrl.toString(),
            timeoutMs: PAGE_INFO_HTTP_TIMEOUT_MS,
            maxRedirects: PAGE_INFO_HTTP_MAX_REDIRECTS,
            init: {
                method: "GET",
                redirect: "manual",
            },
            ...pageInfoHttpTransportOverride,
        });
        try {
            if (!guarded.response.ok) {
                throw new Error(
                    `Failed to fetch page info: ${guarded.response.status} ${guarded.response.statusText}`
                );
            }
            const content = await readBoundedPageHtml(guarded.response);
            // Prefer the post-redirect URL for relative image/link resolution.
            let baseUrl = parsedUrl;
            try {
                baseUrl = new URL(guarded.finalUrl || parsedUrl.toString());
            } catch {
                // error-policy:J3 finalUrl is transport-reported; keep the
                // pre-validated request URL if it is not a valid absolute URL.
                baseUrl = parsedUrl;
            }
            const title = extractTitle(content, url);
            const { description, metadata } = extractMetaTags(content);
            const images = extractImages(content, baseUrl);
            const links = extractLinks(content, baseUrl);
            return {
                title,
                description,
                content,
                metadata,
                images,
                links,
            };
        } finally {
            await guarded.release();
        }
    }
}
