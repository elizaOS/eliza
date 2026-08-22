/**
 * Worker-safe public web search for stateless Eliza runtimes. This entrypoint
 * owns the genuine WEB_SEARCH action without importing Tavily, Node services,
 * credentials, private data, or browser control.
 */

import type {
    Action,
    ActionResult,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    Plugin,
    State,
} from "@elizaos/core/edge";
import { searchKeylessWeb } from "@elizaos/core/edge";

export const WEB_SEARCH_EDGE_COMPATIBILITY = {
    target: "edge",
    state: "none",
    effects: ["public-network-read"],
    requiredBindings: [],
    requiredSecrets: [],
} as const;

function readParameters(options: unknown): Record<string, unknown> {
    if (!options || typeof options !== "object") return {};
    const record = options as Record<string, unknown>;
    return record.parameters && typeof record.parameters === "object"
        ? (record.parameters as Record<string, unknown>)
        : record;
}

function readQuery(parameters: Record<string, unknown>): string | undefined {
    for (const key of ["query", "q", "objective"]) {
        const value = parameters[key];
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
}

function readResultCount(parameters: Record<string, unknown>): number | undefined {
    const value = parameters.numResults ?? parameters.num_results;
    const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(10, Math.floor(parsed)) : undefined;
}

async function fail(
    text: string,
    callback?: HandlerCallback,
    query?: string
): Promise<ActionResult> {
    await callback?.({ text });
    return {
        success: false,
        text,
        data: { actionName: "WEB_SEARCH", ...(query ? { query } : {}) },
        error: text,
    };
}

export const webSearchEdgeAction: Action = {
    name: "WEB_SEARCH",
    similes: ["SEARCH_WEB", "WEB_QUERY", "FIND_ONLINE", "SEARCH_INTERNET"],
    tags: ["resource:web", "capability:read"],
    contexts: ["general"],
    roleGate: { minRole: "GUEST" },
    description:
        "Search the current public web for facts, news, recommendations, products, places, or other information that may have changed. Returns bounded source results for Eliza to answer from. This does not control a browser or access private accounts.",
    parameters: [
        {
            name: "query",
            description: "Specific public-web search query.",
            required: true,
            schema: { type: "string" },
        },
        {
            name: "numResults",
            description: "Optional result count, from 1 through 10.",
            required: false,
            schema: { type: "number" },
        },
    ],
    validate: async () => true,
    handler: async (
        _runtime: IAgentRuntime,
        _message: Memory,
        _state?: State,
        options?: unknown,
        callback?: HandlerCallback
    ): Promise<ActionResult> => {
        const parameters = readParameters(options);
        const query = readQuery(parameters);
        if (!query) return await fail("A web search query is required.", callback);

        const result = await searchKeylessWeb(query, {
            resultCount: readResultCount(parameters),
        });
        if (!result) {
            return await fail("Web search is temporarily unavailable.", callback, query);
        }
        return {
            success: true,
            text: result.text,
            data: {
                actionName: "WEB_SEARCH",
                query,
                provider: result.provider,
                truncated: result.truncated,
                value: result.text,
            },
        };
    },
};

export const webSearchEdgePlugin: Plugin = {
    name: "web-search-edge",
    description: "Credential-free, public, read-only web search for edge runtimes.",
    actions: [webSearchEdgeAction],
};

export default webSearchEdgePlugin;
