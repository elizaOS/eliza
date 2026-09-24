/** Credential-free public web search for Node and Worker runtimes. */
import type { Plugin } from "@elizaos/core";
import { webSearchEdgePlugin } from "./edge";

export const webSearchPlugin: Plugin = { ...webSearchEdgePlugin, name: "webSearch" };
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
