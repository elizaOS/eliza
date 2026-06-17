// Contract test that keeps the web-search mock matching the real Tavily API.
//
// plugin-web-search consumes the `@tavily/core` SDK, so the "real API shape" is
// the SDK's `TavilySearchResponse` type. This test pins the mock to that type:
// the fixture is annotated `TavilySearchResponse`, so if the pinned `@tavily/core`
// drifts (renames/removes a field the parser reads), this file fails to compile —
// catching contract drift at typecheck time. It then runs the response through
// the real `WebSearchService.search()` normalizer and asserts the DTO maps every
// field (title/url/content/rawContent/score/publishedDate) the parser reads.
// webSearchService.real.test.ts re-validates against the live Tavily API.

import type { IAgentRuntime } from "@elizaos/core";
import type { TavilySearchResponse } from "@tavily/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSearchService } from "./webSearchService";

const searchMock = vi.hoisted(() => vi.fn());
vi.mock("@tavily/core", () => ({
    tavily: vi.fn(() => ({ search: searchMock })),
}));

function runtime(settings: Record<string, string | undefined>): IAgentRuntime {
    return { getSetting: (key: string) => settings[key] } as unknown as IAgentRuntime;
}

// A fixture annotated as the REAL SDK response type. The annotation is the
// contract: a future @tavily/core that renames `rawContent`/`publishedDate`/etc.
// makes this object stop type-checking, so the mock can't silently diverge.
const REAL_TAVILY_RESPONSE: TavilySearchResponse = {
    query: "what is elizaos",
    answer: "elizaOS is an open-source framework for autonomous AI agents.",
    responseTime: 1.23,
    requestId: "req-abc-123",
    images: [
        { url: "https://example.com/a.png", description: "a diagram" },
        { url: "https://example.com/b.png" },
    ],
    results: [
        {
            title: "elizaOS — autonomous agents",
            url: "https://elizaos.example/docs",
            content: "elizaOS lets you build and deploy autonomous agents.",
            rawContent: "<html>elizaOS lets you build and deploy autonomous agents.</html>",
            score: 0.97,
            publishedDate: "2026-05-01T00:00:00.000Z",
        },
        {
            title: "Getting started",
            url: "https://elizaos.example/start",
            content: "Install the CLI and create your first agent.",
            score: 0.81,
            publishedDate: "2026-04-15T00:00:00.000Z",
        },
    ],
};

afterEach(() => {
    vi.restoreAllMocks();
    searchMock.mockReset();
});

describe("web search — Tavily SDK contract", () => {
    it("normalizes a real-typed TavilySearchResponse into the DTO", async () => {
        searchMock.mockResolvedValue(REAL_TAVILY_RESPONSE);
        const service = await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));

        const dto = await service.search("what is elizaos");

        expect(dto.results).toHaveLength(2);
        const first = dto.results[0];
        expect(first?.title).toBe("elizaOS — autonomous agents");
        expect(first?.url).toBe("https://elizaos.example/docs");
        // content -> both description + content; the real `rawContent` is carried.
        expect(first?.content).toContain("autonomous agents");
        expect(first?.rawContent).toContain("<html>");
        expect(first?.score).toBeCloseTo(0.97);
        // publishedDate is parsed; a missing one stays undefined (2nd result has one).
        expect(first?.publishedDate).toBeInstanceOf(Date);

        // images: both string-less {url,description} and bare {url} forms map.
        expect(dto.images.length).toBeGreaterThanOrEqual(2);
        expect(dto.images[0]?.url).toBe("https://example.com/a.png");

        // The Tavily `answer` surfaces on the DTO.
        expect(dto.answer).toContain("elizaOS");
    });

    it("tolerates a sparse real response (missing optional fields) without throwing", async () => {
        // A minimal-but-valid TavilySearchResponse — optional fields omitted.
        const sparse: TavilySearchResponse = {
            query: "q",
            responseTime: 0.1,
            requestId: "req-2",
            images: [],
            results: [
                {
                    title: "Only required fields",
                    url: "https://example.com",
                    content: "",
                    score: 0,
                    publishedDate: "",
                },
            ],
        };
        searchMock.mockResolvedValue(sparse);
        const service = await WebSearchService.start(runtime({ TAVILY_API_KEY: "tvly-test" }));
        const dto = await service.search("q");
        expect(dto.results[0]?.title).toBe("Only required fields");
        expect(dto.results[0]?.score).toBe(0);
        expect(dto.results[0]?.rawContent).toBeUndefined();
    });
});
