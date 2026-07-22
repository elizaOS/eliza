import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SerpdiveSearchService } from "./serpdiveSearchService";

const searchMock = vi.hoisted(() => vi.fn());
// A function expression, not an arrow: the service instantiates the SDK with
// `new SerpDive(...)`, and arrows are not constructible.
const serpdiveMock = vi.hoisted(() =>
    vi.fn(function (this: unknown) {
        return { search: searchMock };
    })
);

vi.mock("serpdive", () => ({
    SerpDive: serpdiveMock,
}));

function runtime(settings: Record<string, string | undefined>): IAgentRuntime {
    return {
        getSetting: (key: string) => settings[key],
    } as unknown as IAgentRuntime;
}

describe("SerpdiveSearchService", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        searchMock.mockReset();
        serpdiveMock.mockClear();
    });

    it("starts inert without SERPDIVE_API_KEY and trims configured keys", async () => {
        // Graceful degradation: missing/blank keys must NOT crash agent boot.
        const inert = await SerpdiveSearchService.start(runtime({}));
        await expect(inert.search("anything")).rejects.toThrow(
            "Web search is not configured: set SERPDIVE_API_KEY to enable it."
        );
        const blank = await SerpdiveSearchService.start(runtime({ SERPDIVE_API_KEY: "  " }));
        await expect(blank.search("eliza")).rejects.toThrow(
            "Web search is not configured: set SERPDIVE_API_KEY to enable it."
        );
        expect(serpdiveMock).not.toHaveBeenCalled();

        await SerpdiveSearchService.start(runtime({ SERPDIVE_API_KEY: "sd_live_test" }));
        expect(serpdiveMock).toHaveBeenCalledWith({ apiKey: "sd_live_test" });

        serpdiveMock.mockClear();
        await SerpdiveSearchService.start(runtime({ SERPDIVE_API_KEY: "  sd_live_trim  " }));
        expect(serpdiveMock).toHaveBeenCalledWith({ apiKey: "sd_live_trim" });
    });

    it("maps options to the SDK and normalizes the API payload", async () => {
        searchMock.mockResolvedValue({
            query: "provider query",
            model: "moby",
            response_time_ms: 2641,
            answer: "the answer",
            results: [
                {
                    url: "https://example.test",
                    title: "Result",
                    date: "2026-07-11",
                    content: "The fact-carrying text of the page.",
                },
                {
                    url: "https://no-title.test",
                    title: null,
                    content: "Body without a title.",
                },
            ],
        });
        const service = await SerpdiveSearchService.start(
            runtime({ SERPDIVE_API_KEY: "sd_live_test" })
        );

        const response = await service.search("eliza", {
            includeAnswer: true,
            limit: 5,
            searchDepth: "advanced",
        });

        // searchDepth "advanced" maps to the moby model; limit to maxResults.
        expect(searchMock).toHaveBeenCalledWith("eliza", {
            model: "moby",
            answer: true,
            maxResults: 5,
        });

        expect(response.answer).toBe("the answer");
        expect(response.query).toBe("provider query");
        // response_time_ms is converted to Tavily-style seconds.
        expect(response.responseTime).toBeCloseTo(2.641);
        expect(response.images).toEqual([]);
        expect(response.results).toHaveLength(2);
        expect(response.results[0]).toMatchObject({
            title: "Result",
            url: "https://example.test",
            content: "The fact-carrying text of the page.",
            description: "The fact-carrying text of the page.",
            score: 0,
        });
        expect(response.results[0]?.publishedDate).toEqual(new Date("2026-07-11"));
        expect(response.results[1]?.title).toBe("Untitled");
        expect(response.results[1]?.publishedDate).toBeUndefined();
    });

    it("defaults to mako with an answer, honors the native model option", async () => {
        searchMock.mockResolvedValue({ query: "q", results: [] });
        const service = await SerpdiveSearchService.start(
            runtime({ SERPDIVE_API_KEY: "sd_live_test" })
        );

        await service.search("plain");
        expect(searchMock).toHaveBeenLastCalledWith("plain", { model: "mako", answer: true });

        await service.search("deep", { model: "moby", searchDepth: "basic" });
        // The native model option wins over searchDepth.
        expect(searchMock).toHaveBeenLastCalledWith("deep", { model: "moby", answer: true });
    });

    it("rejects malformed queries and options before touching the network", async () => {
        const service = await SerpdiveSearchService.start(
            runtime({ SERPDIVE_API_KEY: "sd_live_test" })
        );

        await expect(service.search("   ")).rejects.toThrow("search query is required");
        await expect(service.search("q", { limit: 0 })).rejects.toThrow(
            "limit must be a positive finite integer"
        );
        await expect(
            service.search("q", { searchDepth: "extreme" as never })
        ).rejects.toThrow("searchDepth must be basic or advanced");
        await expect(service.search("q", { model: "orca" as never })).rejects.toThrow(
            "model must be mako or moby"
        );
        expect(searchMock).not.toHaveBeenCalled();
    });

    it("news, image and video searches delegate to web search without fabricating media", async () => {
        searchMock.mockResolvedValue({
            query: "q",
            results: [
                { url: "https://a.test", title: "A", content: "a" },
                { url: "https://b.test", title: "B", content: "b" },
            ],
        });
        const service = await SerpdiveSearchService.start(
            runtime({ SERPDIVE_API_KEY: "sd_live_test" })
        );

        const news = await service.searchNews("elections", { freshness: "day", limit: 2 });
        expect(searchMock).toHaveBeenLastCalledWith("elections", {
            model: "mako",
            answer: true,
            maxResults: 2,
        });
        expect(news.images).toEqual([]);

        await service.searchVideos("rocket launch");
        // Video search biases the query, same approach as plugin-web-search.
        expect(searchMock).toHaveBeenLastCalledWith(
            "rocket launch video",
            expect.objectContaining({ model: "mako" })
        );

        const images = await service.searchImages("nebula", { limit: 2 });
        expect(images.images).toEqual([]);
    });

    it("derives suggestions from unique result titles", async () => {
        searchMock.mockResolvedValue({
            query: "q",
            results: [
                { url: "https://a.test", title: "Alpha", content: "a" },
                { url: "https://b.test", title: "alpha", content: "dup, case-insensitive" },
                { url: "https://c.test", title: "", content: "no title" },
                { url: "https://d.test", title: "Beta", content: "b" },
            ],
        });
        const service = await SerpdiveSearchService.start(
            runtime({ SERPDIVE_API_KEY: "sd_live_test" })
        );

        await expect(service.getSuggestions("query")).resolves.toEqual(["Alpha", "Beta"]);
        // Suggestions skip the synthesized answer: it costs latency for
        // nothing here.
        expect(searchMock).toHaveBeenLastCalledWith("query", {
            model: "mako",
            answer: false,
            maxResults: 5,
        });
    });
});
