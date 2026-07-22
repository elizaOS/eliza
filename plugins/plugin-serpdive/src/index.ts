/**
 * Entry point for the SERPdive plugin.
 *
 * Exports the `serpdivePlugin` object and the `"web"` search-category
 * definition (`WEB_SEARCH_CATEGORY`). Registering the plugin adds the
 * SERPdive-backed `SerpdiveSearchService` and registers the category with
 * core's search dispatch (via `runtime.registerSearchCategory`) so web/news
 * queries route here. Opt-in, and registers no
 * actions/providers/evaluators/routes.
 *
 * Category registration is guarded exactly like plugin-web-search's, so
 * loading this plugin alongside another web-search provider does not
 * double-register the "web" category — but only one WEB_SEARCH service is
 * active at a time, so pick one provider per agent.
 */

import type { IAgentRuntime, Plugin, SearchCategoryRegistration } from "@elizaos/core";
import { ServiceType } from "@elizaos/core";

import { SerpdiveSearchService } from "./services/serpdiveSearchService";

export const WEB_SEARCH_CATEGORY: SearchCategoryRegistration = {
    category: "web",
    label: "Web",
    description: "Search current web pages through plugin-serpdive.",
    contexts: ["knowledge", "browser"],
    filters: [
        {
            name: "model",
            label: "Model",
            description:
                "SERPdive retrieval depth: mako returns the fact-carrying sentences of each page, moby the full page text.",
            type: "enum",
            options: [
                { label: "Mako (fast, key sentences)", value: "mako" },
                { label: "Moby (full page text)", value: "moby" },
            ],
        },
        {
            name: "includeAnswer",
            label: "Include answer",
            description: "Also return a direct answer synthesized from the sources.",
            type: "boolean",
        },
    ],
    resultSchemaSummary:
        "SearchResponse with query, answer, and results containing title/url/description/content where content is the extracted text of the page.",
    capabilities: ["web", "news", "current-information"],
    source: "plugin-serpdive",
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

export const serpdivePlugin: Plugin = {
    name: "serpdive",
    description:
        "Web search that returns extracted, answer-ready page content through the SERPdive API",
    init: async (_config, runtime) => {
        registerWebSearchCategory(runtime);
    },
    async dispose(runtime) {
        const svc = runtime.getService<SerpdiveSearchService>(SerpdiveSearchService.serviceType);
        await svc?.stop();
    },
    actions: [],
    providers: [],
    services: [SerpdiveSearchService],
};

export default serpdivePlugin;
