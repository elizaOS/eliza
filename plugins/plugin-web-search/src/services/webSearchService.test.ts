import type { IAgentRuntime } from "@elizaos/core";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSearchService } from "./webSearchService";

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
    });

    it("requires TAVILY_API_KEY at startup", async () => {
        await expect(WebSearchService.start(runtime({}))).rejects.toThrow(
            "TAVILY_API_KEY is not set"
        );
        await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));
        expect(tavilyMock).toHaveBeenCalledWith({ apiKey: "tvly-test" });
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

    it("maps news freshness and image searches through the shared search path", async () => {
        searchMock.mockResolvedValue({ results: [] });
        const service = await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));

        await service.searchNews("funding", { freshness: "week", limit: 2 });
        await service.searchImages("diagram", { limit: 4 });

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

    it("extracts page title and description from fetched HTML", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(
                async () =>
                    new Response(
                        '<html><head><title>Example</title><meta name="description" content="Desc"></head></html>'
                    )
            )
        );
        const service = await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));

        await expect(service.getPageInfo("https://example.test/page")).resolves.toMatchObject({
            title: "Example",
            description: "Desc",
            content: expect.stringContaining("<title>Example</title>"),
            metadata: {},
            images: [],
            links: [],
        });
    });

    it("fails page info requests on non-ok HTTP responses", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("missing", { status: 404, statusText: "Not Found" }))
        );
        const service = await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));

        await expect(service.getPageInfo("https://example.test/missing")).rejects.toThrow(
            "Failed to fetch page info: 404 Not Found"
        );
    });

    it("rejects malformed and non-http page info URLs before fetch", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const service = await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));

        await expect(service.getPageInfo("not a url")).rejects.toThrow("Invalid page info URL");
        await expect(service.getPageInfo("data:text/html,<title>x</title>")).rejects.toThrow(
            "Page info URL must use http or https"
        );
        await expect(service.getPageInfo("file:///etc/passwd")).rejects.toThrow(
            "Page info URL must use http or https"
        );
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
