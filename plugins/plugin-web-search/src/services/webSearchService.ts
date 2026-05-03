import { type IAgentRuntime, logger, Service, ServiceType } from "@elizaos/core";
import { tavily } from "@tavily/core";

import type { SearchOptions, SearchResponse } from "../types";

export type TavilyClient = ReturnType<typeof tavily>;

export class WebSearchService extends Service {
    static override serviceType = ServiceType.WEB_SEARCH;
    override capabilityDescription = "Web search via Tavily";

    tavilyClient!: TavilyClient;

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
            throw new Error("TAVILY_API_KEY is not set");
        }
        this.tavilyClient = tavily({ apiKey });
    }

    async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
        try {
            const response = await this.tavilyClient.search(query, {
                includeAnswer: options?.includeAnswer ?? true,
                maxResults: options?.limit ?? 3,
                topic: options?.type ?? "general",
                searchDepth: options?.searchDepth ?? "basic",
                includeImages: options?.includeImages ?? false,
                days: options?.days ?? 3,
            });

            return response as SearchResponse;
        } catch (cause) {
            const err = cause instanceof Error ? cause : new Error(String(cause));
            logger.error({ src: "plugin-web-search", err }, "Web search error");
            throw err;
        }
    }
}
