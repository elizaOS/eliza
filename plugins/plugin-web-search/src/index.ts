import type { IAgentRuntime, Plugin, SearchCategoryRegistration } from "@elizaos/core";
import { ServiceType } from "@elizaos/core";

import { WebSearchService } from "./services/webSearchService";

export const WEB_SEARCH_CATEGORY: SearchCategoryRegistration = {
    category: "web",
    label: "Web",
    description: "Search current web pages through plugin-web-search.",
    contexts: ["knowledge", "browser"],
    filters: [
        {
            name: "topic",
            label: "Topic",
            description: "Tavily search topic.",
            type: "enum",
            options: [
                { label: "General", value: "general" },
                { label: "News", value: "news" },
            ],
        },
        {
            name: "searchDepth",
            label: "Search depth",
            description: "Tavily search depth.",
            type: "enum",
            options: [
                { label: "Basic", value: "basic" },
                { label: "Advanced", value: "advanced" },
            ],
        },
        {
            name: "includeImages",
            label: "Include images",
            description: "Include image results when available.",
            type: "boolean",
        },
    ],
    resultSchemaSummary:
        "SearchResponse with query, answer, results containing title/url/description/content/score, and optional images.",
    capabilities: ["web", "news", "current-information"],
    source: "plugin-web-search",
    serviceType: ServiceType.WEB_SEARCH,
};

export function registerWebSearchCategory(runtime: IAgentRuntime): void {
    try {
        runtime.getSearchCategory(WEB_SEARCH_CATEGORY.category, {
            includeDisabled: true,
        });
        return;
    } catch {
        runtime.registerSearchCategory(WEB_SEARCH_CATEGORY);
    }
}

export const webSearchPlugin: Plugin = {
    name: "webSearch",
    description: "Search the web and get news",
    init: async (_config, runtime) => {
        registerWebSearchCategory(runtime);
    },
    actions: [],
    evaluators: [],
    providers: [],
    services: [WebSearchService],
};

export default webSearchPlugin;
