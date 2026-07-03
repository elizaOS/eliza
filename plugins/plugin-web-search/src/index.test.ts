import { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { WEB_SEARCH_CATEGORY, webSearchPlugin } from "./index";

describe("webSearchPlugin", () => {
    it("registers the web search category from plugin init", async () => {
        const runtime = new AgentRuntime({ logLevel: "fatal" });

        await runtime.registerPlugin(webSearchPlugin);

        expect(runtime.getSearchCategory("web")).toMatchObject({
            category: WEB_SEARCH_CATEGORY.category,
            source: WEB_SEARCH_CATEGORY.source,
            serviceType: WEB_SEARCH_CATEGORY.serviceType,
        });
    });
});
