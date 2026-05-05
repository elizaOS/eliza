import type { Plugin } from "@elizaos/core";

import { webSearch } from "./actions/webSearch";
import { WebSearchService } from "./services/webSearchService";

export const webSearchPlugin: Plugin = {
    name: "webSearch",
    description: "Search the web and get news",
    actions: [webSearch],
    evaluators: [],
    providers: [],
    services: [WebSearchService],
};

export default webSearchPlugin;
