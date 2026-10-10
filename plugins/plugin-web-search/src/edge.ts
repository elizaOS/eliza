/**
 * Worker-safe public web search for stateless Eliza runtimes. This entrypoint
 * owns the genuine WEB_SEARCH action without importing Node services,
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
} from "@elizaos/core";
import { isBlockedHostname, isPrivateIpAddress } from "@elizaos/core";
import { isKeylessWebSearchUnavailableError, searchKeylessWeb } from "./keyless-web-search";

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

export interface WebSearchSourceEvidence {
    url: string;
    /** Complete JSON object that contained this URL; never aggregate provider prose. */
    text: string;
}

const MAX_PROVIDER_JSON_NODES = 512;
const MAX_WEB_SEARCH_QUERY_CODE_POINTS = 2048;
const SOURCE_URL_KEYS = new Set(["url", "source_url", "sourceUrl"]);
const HTTP_URL = /https?:\/\/[^\s<>"']+/giu;
const SOURCE_TEXT_ARRAY_KEYS = new Set(["excerpts"]);

// Keep balanced URL parentheses and remove only excess closing prose marks.
// Trailing "!", "?", and ":" are sentence punctuation in prose, not URL
// characters; a URL ending in one is a dead citation, same as ",.;".
function stripTrailingProsePunctuation(value: string): string {
    let excessClosing = 0;
    for (const char of value) {
        if (char === ")") excessClosing += 1;
        else if (char === "(") excessClosing -= 1;
    }
    let end = value.length;
    while (end > 0) {
        const char = value[end - 1];
        if (
            char === "," ||
            char === "." ||
            char === ";" ||
            char === "!" ||
            char === "?" ||
            char === ":"
        )
            end -= 1;
        else if (char === ")" && excessClosing > 0) {
            end -= 1;
            excessClosing -= 1;
        } else break;
    }
    return value.slice(0, end);
}

function publicHttpUrl(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    try {
        const parsed = new URL(value);
        if (
            (parsed.protocol === "https:" || parsed.protocol === "http:") &&
            !parsed.username &&
            !parsed.password &&
            !isBlockedHostname(parsed.hostname) &&
            !isPrivateIpAddress(parsed.hostname)
        ) {
            return parsed.toString();
        }
    } catch {
        // error-policy:J3 malformed provider URLs are explicit non-sources.
    }
    return undefined;
}

function containsUnsafeHttpUrl(value: string): boolean {
    HTTP_URL.lastIndex = 0;
    for (const match of value.matchAll(HTTP_URL)) {
        if (!publicHttpUrl(stripTrailingProsePunctuation(match[0]))) return true;
    }
    return false;
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
            const recordUrls = new Set<string>();
            const scalarRecord: Record<string, unknown> = {};
            let recordContainsUnsafeUrl = false;
            for (const [key, item] of Object.entries(record)) {
                if (SOURCE_URL_KEYS.has(key)) {
                    const parsed = publicHttpUrl(item);
                    if (parsed) {
                        recordUrls.add(parsed);
                        scalarRecord[key] = parsed;
                    } else if (typeof item === "string") {
                        recordContainsUnsafeUrl = true;
                    }
                    continue;
                }
                if (
                    SOURCE_TEXT_ARRAY_KEYS.has(key) &&
                    Array.isArray(item) &&
                    item.length > 0 &&
                    item.every((value) => typeof value === "string")
                ) {
                    scalarRecord[key] = item;
                    if (item.some((value) => containsUnsafeHttpUrl(value))) {
                        recordContainsUnsafeUrl = true;
                    }
                } else if (item && typeof item === "object") {
                    pending.push(item);
                } else {
                    scalarRecord[key] = item;
                    if (typeof item === "string" && containsUnsafeHttpUrl(item)) {
                        recordContainsUnsafeUrl = true;
                    }
                }
            }
            for (const url of recordUrls) sourceUrls.add(url);
            if (recordUrls.size === 1 && !recordContainsUnsafeUrl) {
                const [recordUrl] = recordUrls;
                sourceTextByUrl.set(recordUrl, JSON.stringify(scalarRecord));
            }
        }
    } catch {
        // error-policy:J3 non-JSON providers retain URL inventory but cannot
        // claim source-bound evidence for current factual assertions.
    }
    for (const prose of decodedStrings(text)) {
        for (const match of prose.matchAll(/https?:\/\/[^\s<>"']+/gu)) {
            const exact = publicHttpUrl(match[0]);
            if (exact && sourceUrls.has(exact)) continue;
            const parsed = publicHttpUrl(stripTrailingProsePunctuation(match[0]));
            if (parsed) sourceUrls.add(parsed);
        }
    }
    return {
        sources: overflowed
            ? []
            : [...sourceTextByUrl].map(([url, sourceText]) => ({
                  url,
                  text: sourceText,
              })),
        sourceUrls: [...sourceUrls],
        overflowed,
    };
}

/**
 * The string values of JSON provider text, decoded: in the raw text `\n` and
 * `\"` escapes would read as URL characters (`/guide\nNext`).
 */
function decodedStrings(text: string): string[] {
    const strings: string[] = [];
    try {
        JSON.parse(text, (_key, value) => {
            if (typeof value === "string") strings.push(value);
            return value;
        });
        return strings;
    } catch {
        // error-policy:J3 non-JSON provider text is scanned as prose.
        return [text];
    }
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
    options: { numResults?: number; signal?: AbortSignal } = {}
): Promise<ActionResult> {
    return runWebSearchWith(
        query,
        (value) => searchKeylessWeb(value, { signal: options.signal }),
        options
    );
}

/** Common receipt handling; the host supplies its authorized browser-first transport. */
export async function runWebSearchWith(
    query: string,
    search: (
        query: string
    ) => Promise<{ provider: string; text: string; truncated: boolean } | null | undefined>,
    options: { signal?: AbortSignal } = {}
): Promise<ActionResult> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return await fail("A web search query is required.");
    if ([...normalizedQuery].length > MAX_WEB_SEARCH_QUERY_CODE_POINTS) {
        return await fail(
            `Web search queries cannot exceed ${MAX_WEB_SEARCH_QUERY_CODE_POINTS} characters.`,
            undefined,
            normalizedQuery
        );
    }
    const observedAt = Date.now();
    options.signal?.throwIfAborted();
    let result: Awaited<ReturnType<typeof search>>;
    try {
        result = await search(normalizedQuery);
    } catch (error) {
        options.signal?.throwIfAborted();
        if (!isKeylessWebSearchUnavailableError(error)) throw error;
        // error-policy:J1 a provider outage is a typed action failure, never "no results".
        return {
            success: false,
            text: "Web search is temporarily unavailable.",
            data: {
                actionName: "WEB_SEARCH",
                query: normalizedQuery,
                unavailable: true,
                provider: error.provider,
                reason: error.reason,
                ...(error.status !== undefined ? { status: error.status } : {}),
                ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
            },
            error: error.message,
        };
    }
    options.signal?.throwIfAborted();
    if (!result) {
        return await fail("Web search returned no results.", undefined, normalizedQuery);
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
            // A Google results-page snapshot is aggregate context, not prose from
            // the individual linked sites. Retain all text without misattribution.
            sources: result.provider === "browser" ? [] : evidence.sources,
            evidenceOverflowed: evidence.overflowed,
            truncated: result.truncated,
            value: result.text,
        },
    };
}

export type WebSearchEdgeRunner = (
    query: string,
    options?: { numResults?: number; signal?: AbortSignal }
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

            const candidateSignal =
                options && typeof options === "object"
                    ? (options as { abortSignal?: unknown }).abortSignal
                    : undefined;
            const signal = candidateSignal instanceof AbortSignal ? candidateSignal : undefined;
            signal?.throwIfAborted();
            const result = await runner(query, { signal });
            signal?.throwIfAborted();
            if (result.success !== true && result.text) {
                await callback?.({ text: result.text });
            }
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
