/** Host web search uses the selected Chromium profile before public-network fallback. */
import type { Action, Plugin } from "@elizaos/core";
import { searchBrowserFirstWeb } from "./browser-web-search";
import { createWebSearchEdgePlugin, runWebSearchWith, webSearchEdgeAction } from "./edge";

export const webSearchAction: Action = {
    ...webSearchEdgeAction,
    description:
        "Search the current web using the agent's explicitly authorized Chromium profile. Uses public keyless search only when no eligible browser is available before dispatch. Dispatched searches are never replayed through another provider.",
    handler: async (runtime, message, state, options, callback) => {
        const action = createWebSearchEdgePlugin((query) =>
            runWebSearchWith(query, (value) => searchBrowserFirstWeb(runtime, value))
        ).actions?.[0];
        if (!action) throw new Error("WEB_SEARCH action is missing");
        return action.handler(runtime, message, state, options, callback);
    },
};
export const webSearchPlugin: Plugin = {
    name: "webSearch",
    description: "Authorized browser-first web search with public keyless fallback.",
    actions: [webSearchAction],
};
export default webSearchPlugin;

export {
    createWebSearchEdgePlugin,
    runWebSearchEdge,
    WEB_SEARCH_EDGE_COMPATIBILITY,
    type WebSearchEdgeRunner,
    type WebSearchSourceEvidence,
    webSearchEdgeAction,
    webSearchEdgePlugin,
    webSearchSourceEvidence,
    webSearchSourceUrls,
} from "./edge";
export {
    type KeylessWebSearchFetch,
    type KeylessWebSearchOptions,
    type KeylessWebSearchProvider,
    type KeylessWebSearchResult,
    searchKeylessWeb,
} from "./keyless-web-search";
