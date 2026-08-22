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

export interface WebSearchSourceEvidence {
    url: string;
    /** Complete JSON object that contained this URL; never aggregate provider prose. */
    text: string;
}

const MAX_PROVIDER_JSON_NODES = 512;
const SOURCE_URL_KEYS = new Set(["url", "source_url", "sourceUrl"]);

function publicHttpUrl(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    try {
        const parsed = new URL(value.replace(/[),.;]+$/u, ""));
        if (
            (parsed.protocol === "https:" || parsed.protocol === "http:") &&
            !parsed.username &&
            !parsed.password
        ) {
            return parsed.toString();
        }
    } catch {
        // error-policy:J3 malformed provider URLs are explicit non-sources.
    }
    return undefined;
}

/**
 * Extracts source-bound evidence with an iterative hostile-JSON budget. A URL
 * is authoritative only for the exact result object that contained it.
 */
export function webSearchSourceEvidence(text: string): {
    sources: WebSearchSourceEvidence[];
    sourceUrls: string[];
    overflowed: boolean;
} {
    const sourceTextByUrl = new Map<string, string>();
    const sourceUrls = new Set<string>();
    let overflowed = false;
    try {
        const pending: unknown[] = [JSON.parse(text)];
        let visited = 0;
        while (pending.length > 0) {
            const value = pending.pop();
            visited += 1;
            if (visited > MAX_PROVIDER_JSON_NODES) {
                overflowed = true;
                break;
            }
            if (Array.isArray(value)) {
                for (const item of value) pending.push(item);
                continue;
            }
            if (!value || typeof value !== "object") continue;
            const record = value as Record<string, unknown>;
            let recordUrl: string | undefined;
            for (const [key, item] of Object.entries(record)) {
                if (SOURCE_URL_KEYS.has(key)) {
                    const parsed = publicHttpUrl(item);
                    if (parsed) recordUrl = parsed;
                }
                if (item && typeof item === "object") pending.push(item);
            }
            if (recordUrl) {
                sourceUrls.add(recordUrl);
                sourceTextByUrl.set(recordUrl, JSON.stringify(record));
            }
        }
    } catch {
        // error-policy:J3 non-JSON providers retain URL inventory but cannot
        // claim source-bound evidence for current factual assertions.
    }
    for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gu)) {
        const parsed = publicHttpUrl(match[0]);
        if (parsed) sourceUrls.add(parsed);
    }
    return {
        sources: overflowed
            ? []
            : [...sourceTextByUrl].map(([url, sourceText]) => ({ url, text: sourceText })),
        sourceUrls: [...sourceUrls],
        overflowed,
    };
}

/** Extracts traceable public HTTP sources without interpreting provider prose. */
export function webSearchSourceUrls(text: string): string[] {
    return webSearchSourceEvidence(text).sourceUrls;
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

/** Runs the same public-read implementation used by the registered action. */
export async function runWebSearchEdge(
    query: string,
    options: { numResults?: number } = {}
): Promise<ActionResult> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return await fail("A web search query is required.");
    const observedAt = Date.now();
    const result = await searchKeylessWeb(normalizedQuery, {
        resultCount: options.numResults,
    });
    if (!result) {
        return await fail("Web search is temporarily unavailable.", undefined, normalizedQuery);
    }
    const evidence = webSearchSourceEvidence(result.text);
    return {
        success: true,
        text: result.text,
        data: {
            actionName: "WEB_SEARCH",
            query: normalizedQuery,
            provider: result.provider,
            observedAt,
            sourceUrls: evidence.sourceUrls,
            sources: evidence.sources,
            evidenceOverflowed: evidence.overflowed,
            truncated: result.truncated,
            value: result.text,
        },
    };
}

export type WebSearchEdgeRunner = (
    query: string,
    options?: { numResults?: number }
) => Promise<ActionResult>;

function createWebSearchEdgeAction(runner: WebSearchEdgeRunner): Action {
    return {
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

            const result = await runner(query, {
                numResults: readResultCount(parameters),
            });
            return result;
        },
    };
}

export const webSearchEdgeAction: Action = createWebSearchEdgeAction(runWebSearchEdge);

/** Creates an edge plugin whose runner may reuse a server-owned read receipt. */
export function createWebSearchEdgePlugin(runner: WebSearchEdgeRunner = runWebSearchEdge): Plugin {
    return {
        name: "web-search-edge",
        description: "Credential-free, public, read-only web search for edge runtimes.",
        actions: [createWebSearchEdgeAction(runner)],
    };
}

export const webSearchEdgePlugin: Plugin = {
    name: "web-search-edge",
    description: "Credential-free, public, read-only web search for edge runtimes.",
    actions: [webSearchEdgeAction],
};

export default webSearchEdgePlugin;
