/**
 * Deterministic unit suite for `WebSearchService`: Tavily option mapping,
 * graceful degradation without a key, HTML page-info extraction, and
 * SSRF-closed page fetches via the real shared guard with an injected
 * transport (never stub the guard away).
 */
import { ElizaError, type IAgentRuntime, SsrfBlockedError } from "@elizaos/core";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchOptions } from "../types";
import { setPageInfoHttpTransportForTests, WebSearchService } from "./webSearchService";

const searchMock = vi.hoisted(() => vi.fn());
const tavilyMock = vi.hoisted(() => vi.fn(() => ({ search: searchMock })));

vi.mock("@tavily/core", () => ({
    tavily: tavilyMock,
}));

function runtime(settings: Record<string, string | undefined>): IAgentRuntime {
    return {
        getSetting: (key: string) => settings[key],
    } as unknown as IAgentRuntime;
}

describe("WebSearchService", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        searchMock.mockReset();
        tavilyMock.mockClear();
        setPageInfoHttpTransportForTests(undefined);
    });

    it("starts inert without TAVILY_API_KEY and trims configured keys", async () => {
        // Graceful degradation: missing/blank keys must NOT crash agent boot.
        const inert = await WebSearchService.start(runtime({}));
        await expect(inert.search("anything")).rejects.toThrow(
            "Web search is not configured: set TAVILY_API_KEY to enable it."
        );
        const blank = await WebSearchService.start(runtime({ TAVILY_API_KEY: "  " }));
        await expect(blank.search("eliza")).rejects.toThrow(
            "Web search is not configured: set TAVILY_API_KEY to enable it."
        );
        expect(tavilyMock).not.toHaveBeenCalled();

        await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));
        expect(tavilyMock).toHaveBeenCalledWith({ apiKey: "tvly-test" });

        tavilyMock.mockClear();
        await WebSearchService.start(runtime({ TAVILY_API_KEY: "  tvly-trimmed  " }));
        expect(tavilyMock).toHaveBeenCalledWith({ apiKey: "tvly-trimmed" });
    });

    it("maps search options to Tavily and normalizes sparse results", async () => {
        searchMock.mockResolvedValue({
            answer: "answer",
            query: "provider query",
            responseTime: 1.25,
            images: [
                "https://img.test/a.png",
                { url: "https://img.test/b.png", description: "B" },
                {},
            ],
            results: [
                {
                    title: "Result",
                    url: "https://example.test",
                    content: "Snippet",
                    rawContent: "Raw",
                    score: 0.92,
                    publishedDate: "2026-05-01T00:00:00.000Z",
                },
                {
                    publishedDate: "not-a-date",
                },
            ],
        });
        const service = await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));

        await expect(
            service.search("eliza", {
                includeAnswer: false,
                limit: 5,
                topic: "news",
                searchDepth: "advanced",
                includeImages: true,
                days: 10,
            })
        ).resolves.toEqual({
            answer: "answer",
            query: "provider query",
            responseTime: 1.25,
            images: [
                { url: "https://img.test/a.png" },
                { url: "https://img.test/b.png", description: "B" },
            ],
            results: [
                {
                    title: "Result",
                    url: "https://example.test",
                    description: "Snippet",
                    content: "Snippet",
                    rawContent: "Raw",
                    score: 0.92,
                    publishedDate: new Date("2026-05-01T00:00:00.000Z"),
                },
                {
                    title: "Untitled",
                    url: "",
                    description: "",
                    content: "",
                    rawContent: undefined,
                    score: 0,
                    publishedDate: undefined,
                },
            ],
        });
        expect(searchMock).toHaveBeenCalledWith("eliza", {
            includeAnswer: false,
            maxResults: 5,
            topic: "news",
            searchDepth: "advanced",
            includeImages: true,
            days: 10,
        });
    });

    it("rejects malformed search queries and options before Tavily calls", async () => {
        const service = await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));

        await expect(service.search(" \n\t ")).rejects.toThrow("search query is required");
        await expect(service.search(42 as unknown as string)).rejects.toThrow(
            "search query is required"
        );
        await expect(
            service.search("eliza", "limit=3" as unknown as SearchOptions)
        ).rejects.toThrow("search options must be an object");
        await expect(service.search("eliza", { limit: 0 })).rejects.toThrow(
            "limit must be a positive finite integer"
        );
        await expect(service.search("eliza", { limit: 1.5 })).rejects.toThrow(
            "limit must be a positive finite integer"
        );
        await expect(service.search("eliza", { days: Number.POSITIVE_INFINITY })).rejects.toThrow(
            "days must be a non-negative finite integer"
        );
        await expect(
            service.search("eliza", { topic: "javascript:alert(1)" } as unknown as SearchOptions)
        ).rejects.toThrow("topic must be general or news");
        await expect(
            service.search("eliza", { searchDepth: "deep" } as unknown as SearchOptions)
        ).rejects.toThrow("searchDepth must be basic or advanced");
        await expect(
            service.search("eliza", { includeImages: "true" } as unknown as SearchOptions)
        ).rejects.toThrow("includeImages must be a boolean");
        expect(searchMock).not.toHaveBeenCalled();
    });

    it("maps news freshness and image searches through the shared search path", async () => {
        searchMock.mockResolvedValue({ results: [] });
        const service = await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));

        await service.searchNews("funding", { freshness: "week", limit: 2 });
        await service.searchImages("diagram", { limit: 4 });
        await service.searchVideos("demo", { limit: 3 });

        expect(searchMock).toHaveBeenNthCalledWith(
            1,
            "funding",
            expect.objectContaining({
                topic: "news",
                days: 7,
                maxResults: 2,
            })
        );
        expect(searchMock).toHaveBeenNthCalledWith(
            2,
            "diagram",
            expect.objectContaining({
                includeImages: true,
                maxResults: 4,
            })
        );
        expect(searchMock).toHaveBeenNthCalledWith(
            3,
            "demo video",
            expect.objectContaining({
                includeImages: true,
                maxResults: 3,
            })
        );

        await service.searchNews("funding", { days: 14 });
        expect(searchMock).toHaveBeenLastCalledWith(
            "funding",
            expect.objectContaining({
                topic: "news",
                days: 14,
            })
        );
    });

    it("derives suggestions and trending searches from Tavily result titles", async () => {
        searchMock
            .mockResolvedValueOnce({
                results: [
                    { title: "Eliza agents", content: "" },
                    { title: "eliza agents", content: "" },
                    { title: "Untitled", content: "" },
                    { title: "Remote plugin docs", content: "" },
                ],
            })
            .mockResolvedValueOnce({
                results: [
                    { title: "Market update", content: "" },
                    { title: "Policy update", content: "" },
                ],
            });
        const service = await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));

        await expect(service.getSuggestions(" eliza ")).resolves.toEqual([
            "Eliza agents",
            "Remote plugin docs",
        ]);
        await expect(service.getTrendingSearches("US")).resolves.toEqual([
            "Market update",
            "Policy update",
        ]);

        expect(searchMock).toHaveBeenNthCalledWith(
            1,
            "eliza",
            expect.objectContaining({
                includeAnswer: false,
                maxResults: 5,
                searchDepth: "basic",
                topic: "general",
            })
        );
        expect(searchMock).toHaveBeenNthCalledWith(
            2,
            "trending news in US",
            expect.objectContaining({
                topic: "news",
                days: 1,
                maxResults: 5,
            })
        );
    });

    it("propagates Tavily errors", async () => {
        searchMock.mockRejectedValue(new Error("tavily unavailable"));
        const service = await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));

        await expect(service.search("eliza")).rejects.toThrow("tavily unavailable");
    });

    it("fuzzes malformed provider payloads into a stable response shape", async () => {
        const service = await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));

        await fc.assert(
            fc.asyncProperty(fc.jsonValue(), async (payload) => {
                searchMock.mockResolvedValueOnce(payload);

                const response = await service.search("hostile payload");

                expect(response.query).toEqual(expect.any(String));
                expect(response.images).toEqual(expect.any(Array));
                expect(response.results).toEqual(expect.any(Array));
                for (const image of response.images) {
                    expect(image.url).toEqual(expect.any(String));
                    expect(image.url.length).toBeGreaterThan(0);
                }
                for (const result of response.results) {
                    expect(result).toEqual(
                        expect.objectContaining({
                            title: expect.any(String),
                            url: expect.any(String),
                            description: expect.any(String),
                            content: expect.any(String),
                            score: expect.any(Number),
                        })
                    );
                    expect(Number.isNaN(result.score)).toBe(false);
                }
            }),
            { numRuns: 200 }
        );
    });

    it("extracts page title, description, metadata, images, and links from fetched HTML", async () => {
        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>
                    Example &amp; Demo &#39;Page&#39;
                </title>
                <meta content="A &quot;great&quot; description" name="description">
                <meta property="og:title" content="OG Example">
                <meta property="og:image" content="/images/og.png">
            </head>
            <body>
                <h1>Hello</h1>
                <img src="/assets/hero.jpg" alt="Hero">
                <img src="https://external.test/logo.svg">
                <img src="data:image/png;base64,12345">
                <a href="/docs/guide.html">Guide</a>
                <a href="https://other.test/about">About</a>
                <a href="#top">Anchor</a>
                <a href="javascript:void(0)">JS</a>
            </body>
            </html>
        `;
        const fetchImpl = vi.fn(async () => new Response(html));
        // Inject transport so the real SSRF policy still runs against public hosts.
        setPageInfoHttpTransportForTests({ fetchImpl });
        const service = await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));

        const pageInfo = await service.getPageInfo("https://example.test/page");
        expect(pageInfo.title).toBe("Example & Demo 'Page'");
        expect(pageInfo.description).toBe('A "great" description');
        expect(pageInfo.metadata).toEqual({
            description: 'A "great" description',
            "og:title": "OG Example",
            "og:image": "/images/og.png",
        });
        expect(pageInfo.images).toEqual([
            "https://example.test/assets/hero.jpg",
            "https://external.test/logo.svg",
        ]);
        expect(pageInfo.links).toEqual([
            "https://example.test/docs/guide.html",
            "https://other.test/about",
        ]);
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it("decodes astral numeric entities and preserves invalid Unicode code points", async () => {
        const html = `<title>&#128512; &#x1F680; &#0; &#xD800; &#1114112;</title>`;
        setPageInfoHttpTransportForTests({
            fetchImpl: vi.fn(async () => new Response(html)),
        });
        const service = await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));

        const pageInfo = await service.getPageInfo("https://example.test/entities");

        expect(pageInfo.title).toBe("😀 🚀 &#0; &#xD800; &#1114112;");
    });

    it("decodes each HTML entity exactly once", async () => {
        const html = `<title>&amp;lt;literal&amp;gt; &amp;#65;</title>`;
        setPageInfoHttpTransportForTests({
            fetchImpl: vi.fn(async () => new Response(html)),
        });
        const service = await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));

        const pageInfo = await service.getPageInfo("https://example.test/entities-once");

        expect(pageInfo.title).toBe("&lt;literal&gt; &#65;");
    });

    it("accepts page HTML exactly at the byte limit", async () => {
        const exactLimitHtml = "a".repeat(1024 * 1024);
        setPageInfoHttpTransportForTests({
            fetchImpl: vi.fn(
                async () =>
                    new Response(exactLimitHtml, {
                        headers: { "content-length": String(1024 * 1024) },
                    })
            ),
        });
        const service = await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));

        const pageInfo = await service.getPageInfo("https://example.test/exact-limit");

        expect(pageInfo.content).toHaveLength(1024 * 1024);
    });

    it("rejects and cancels a body whose declared length exceeds the byte limit", async () => {
        const cancel = vi.fn();
        const pull = vi.fn();
        const body = new ReadableStream<Uint8Array>({ cancel, pull });
        setPageInfoHttpTransportForTests({
            fetchImpl: vi.fn(
                async () =>
                    new Response(body, {
                        headers: { "content-length": String(1024 * 1024 + 1) },
                    })
            ),
        });
        const service = await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));

        const error = await service
            .getPageInfo("https://example.test/declared-oversize")
            .catch((cause: unknown) => cause);

        expect(error).toBeInstanceOf(ElizaError);
        expect((error as ElizaError).code).toBe("PAGE_INFO_HTML_TOO_LARGE");
        expect(cancel).toHaveBeenCalledWith("page info HTML exceeded size limit");
    });

    it("stops reading and cancels a streamed body as soon as it crosses the byte limit", async () => {
        const cancel = vi.fn();
        const chunks = [new Uint8Array(1024 * 1024), new Uint8Array([1])];
        const body = new ReadableStream<Uint8Array>(
            {
                cancel,
                pull(controller) {
                    const chunk = chunks.shift();
                    if (chunk) controller.enqueue(chunk);
                    else controller.close();
                },
            },
            { highWaterMark: 0 }
        );
        setPageInfoHttpTransportForTests({
            fetchImpl: vi.fn(async () => new Response(body)),
        });
        const service = await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));

        const error = await service
            .getPageInfo("https://example.test/streamed-oversize")
            .catch((cause: unknown) => cause);

        expect(error).toBeInstanceOf(ElizaError);
        expect((error as ElizaError).code).toBe("PAGE_INFO_HTML_TOO_LARGE");
        expect(cancel).toHaveBeenCalledWith("page info HTML exceeded size limit");
    });

    it("preserves a streamed body read failure as a typed boundary error", async () => {
        const readFailure = new Error("socket reset");
        const body = new ReadableStream<Uint8Array>({
            pull() {
                throw readFailure;
            },
        });
        setPageInfoHttpTransportForTests({
            fetchImpl: vi.fn(async () => new Response(body)),
        });
        const service = await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));

        const error = await service
            .getPageInfo("https://example.test/read-failure")
            .catch((cause: unknown) => cause);

        expect(error).toBeInstanceOf(ElizaError);
        expect((error as ElizaError).code).toBe("PAGE_INFO_BODY_READ_FAILED");
        expect((error as ElizaError).cause).toBe(readFailure);
    });

    it("falls back to og:description when standard description meta tag is absent", async () => {
        const html = `<html><head><title>Test</title><meta property="og:description" content="Fallback Og Desc"></head></html>`;
        setPageInfoHttpTransportForTests({
            fetchImpl: vi.fn(async () => new Response(html)),
        });
        const service = await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));

        const pageInfo = await service.getPageInfo("https://example.test/og");
        expect(pageInfo.description).toBe("Fallback Og Desc");
    });

    it("fails page info requests on non-ok HTTP responses", async () => {
        setPageInfoHttpTransportForTests({
            fetchImpl: vi.fn(
                async () => new Response("missing", { status: 404, statusText: "Not Found" })
            ),
        });
        const service = await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));

        await expect(service.getPageInfo("https://example.test/missing")).rejects.toThrow(
            "Failed to fetch page info: 404 Not Found"
        );
    });

    it("rejects malformed and non-http page info URLs before fetch", async () => {
        const fetchImpl = vi.fn();
        setPageInfoHttpTransportForTests({ fetchImpl });
        const service = await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));

        await expect(service.getPageInfo("not a url")).rejects.toThrow("Invalid page info URL");
        await expect(service.getPageInfo("data:text/html,<title>x</title>")).rejects.toThrow(
            "Page info URL must use http or https"
        );
        await expect(service.getPageInfo("file:///etc/passwd")).rejects.toThrow(
            "Page info URL must use http or https"
        );
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("fails closed on private, loopback, and link-local page info URLs", async () => {
        const fetchImpl = vi.fn(async () => new Response("<title>should not load</title>"));
        setPageInfoHttpTransportForTests({ fetchImpl });
        const service = await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));

        await expect(service.getPageInfo("http://127.0.0.1/secret")).rejects.toBeInstanceOf(
            SsrfBlockedError
        );
        await expect(
            service.getPageInfo("http://169.254.169.254/latest/meta-data/")
        ).rejects.toBeInstanceOf(SsrfBlockedError);
        await expect(service.getPageInfo("http://localhost/admin")).rejects.toBeInstanceOf(
            SsrfBlockedError
        );
        await expect(service.getPageInfo("http://[::1]/")).rejects.toBeInstanceOf(SsrfBlockedError);
        // Policy must reject before the injected transport is invoked.
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
