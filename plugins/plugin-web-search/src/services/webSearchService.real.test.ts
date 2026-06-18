// Live validation that the web-search mock/parser matches the REAL Tavily API.
//
// Runs a real query through the actual @tavily/core SDK with a real TAVILY_API_KEY
// and asserts WebSearchService.search() normalizes the live response into a valid
// DTO — i.e. the type-pinned fixture in webSearchService.contract.test.ts still
// matches reality. Gated: TAVILY_LIVE_TEST=1 (or TEST_LANE=post-merge) AND
// TAVILY_API_KEY present. Skips cleanly otherwise.

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { WebSearchService } from "./webSearchService";

const TOKEN = process.env.TAVILY_API_KEY ?? "";
const LIVE =
    (process.env.TAVILY_LIVE_TEST === "1" || process.env.TEST_LANE === "post-merge") &&
    TOKEN.length > 0;

function runtime(): IAgentRuntime {
    return {
        getSetting: (key: string) => (key === "TAVILY_API_KEY" ? TOKEN : undefined),
    } as unknown as IAgentRuntime;
}

describe.skipIf(!LIVE)("web search — live Tavily API parser validation", () => {
    it("live search normalizes into a valid DTO", async () => {
        const service = await WebSearchService.start(runtime());
        const dto = await service.search("elizaOS autonomous agents framework", {
            limit: 3,
        });
        expect(Array.isArray(dto.results)).toBe(true);
        expect(dto.results.length).toBeGreaterThan(0);
        for (const r of dto.results) {
            expect(typeof r.title).toBe("string");
            expect(r.url).toMatch(/^https?:\/\//);
            expect(typeof r.content).toBe("string");
            expect(typeof r.score).toBe("number");
        }
    }, 30_000);
});
