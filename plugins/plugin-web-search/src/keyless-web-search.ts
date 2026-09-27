/**
 * Bounded keyless web search shared by Node and Workerd Eliza runtimes. The
 * provider endpoints are fixed, redirects are refused, and response bodies are
 * capped while streaming. A successful zero-hit search resolves `undefined`;
 * every provider failure (HTTP error, rate limit, timeout, transport error,
 * malformed or conflicting MCP payload, oversized body, caller cancellation)
 * throws `KeylessWebSearchUnavailableError`, so callers never report an outage
 * as "no results". Diagnostics never carry query text or provider payloads.
 */

const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RESPONSE_BYTES = 256 * 1024;
/** JSON-RPC id of the one `tools/call` request each search dispatches. */
const MCP_REQUEST_ID = 1;

export type KeylessWebSearchProvider = "parallel";
export type KeylessWebSearchFetch = (
    input: RequestInfo | URL,
    init?: RequestInit
) => Promise<Response>;

export interface KeylessWebSearchOptions {
    timeoutMs?: number;
    maxResponseBytes?: number;
    /** @deprecated Search results are always returned in full. */
    maxResultChars?: number;
    fetchImpl?: KeylessWebSearchFetch;
    /** Caller cancellation; an aborted search is never dispatched. */
    signal?: AbortSignal;
}

export interface KeylessWebSearchResult {
    provider: KeylessWebSearchProvider;
    text: string;
    truncated: boolean;
}

export type KeylessWebSearchFailureReason =
    | "aborted"
    | "timeout"
    | "network"
    | "rate_limited"
    | "http_error"
    | "unsupported_content_type"
    | "response_too_large"
    | "provider_error"
    | "malformed_response";

/** Typed provider failure. Distinct from a successful empty search. */
export class KeylessWebSearchUnavailableError extends Error {
    override readonly name = "KeylessWebSearchUnavailableError";
    readonly code = "WEB_SEARCH_UNAVAILABLE";
    readonly provider: KeylessWebSearchProvider;
    readonly reason: KeylessWebSearchFailureReason;
    readonly status?: number;
    /** Provider-requested delay from `Retry-After`, in milliseconds. */
    readonly retryAfterMs?: number;

    constructor(args: {
        provider: KeylessWebSearchProvider;
        reason: KeylessWebSearchFailureReason;
        status?: number;
        retryAfterMs?: number;
        cause?: unknown;
    }) {
        const status = args.status === undefined ? "" : ` (HTTP ${args.status})`;
        super(
            `Keyless web search provider ${args.provider} is unavailable: ${args.reason}${status}`,
            args.cause === undefined ? undefined : { cause: args.cause }
        );
        this.provider = args.provider;
        this.reason = args.reason;
        if (args.status !== undefined) this.status = args.status;
        if (args.retryAfterMs !== undefined) this.retryAfterMs = args.retryAfterMs;
    }
}

/** Structural check, so separately bundled entrypoints recognize the error. */
export function isKeylessWebSearchUnavailableError(
    error: unknown
): error is KeylessWebSearchUnavailableError {
    return (
        error instanceof Error &&
        error.name === "KeylessWebSearchUnavailableError" &&
        (error as { code?: unknown }).code === "WEB_SEARCH_UNAVAILABLE"
    );
}

type McpOutcome = { kind: "text"; text: string } | { kind: "error"; reason: "provider_error" };

type JsonRpcResponse = {
    id?: unknown;
    error?: unknown;
    result?: { isError?: unknown; content?: unknown };
};

function parseJsonObject(payload: string): Record<string, unknown> | undefined {
    const trimmed = payload.trim();
    if (!trimmed.startsWith("{")) return undefined;
    try {
        const value: unknown = JSON.parse(trimmed);
        return value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined;
    } catch {
        // error-policy:J3 MCP payloads are untrusted; an invalid envelope is malformed.
        return undefined;
    }
}

/** Interpret one JSON-RPC response bound to our request. */
function readResponse(response: JsonRpcResponse): McpOutcome | undefined {
    if (response.error !== undefined || response.result?.isError === true) {
        return { kind: "error", reason: "provider_error" };
    }
    const content = response.result?.content;
    if (!Array.isArray(content)) return undefined;
    const texts: string[] = [];
    for (const item of content) {
        if (item && typeof item === "object" && typeof item.text === "string") {
            texts.push(item.text);
        }
    }
    if (texts.length === 0) return undefined;
    return { kind: "text", text: texts.join("\n") };
}

/**
 * Parse a Server-Sent Events body into complete events. Multi-line `data:`
 * fields are joined with "\n" and the optional single space after the colon
 * is stripped, per the SSE specification.
 */
function parseSseData(body: string): string[] {
    const events: string[] = [];
    let data: string[] | undefined;
    const flush = () => {
        if (data) events.push(data.join("\n"));
        data = undefined;
    };
    for (const line of body.split(/\r\n|\r|\n/)) {
        if (line === "") {
            flush();
            continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        if (field !== "data") continue;
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        data ??= [];
        data.push(value);
    }
    flush();
    return events;
}

/**
 * Bind the MCP body to our request. A plain JSON body is the response itself.
 * Otherwise the body is read as SSE (servers do not always label it):
 * notifications and responses to other ids are ignored, the response to our
 * id must appear, identical replays collapse, and conflicting responses are
 * rejected as malformed.
 */
function parseMcpBody(body: string): McpOutcome | undefined {
    const direct = parseJsonObject(body) as JsonRpcResponse | undefined;
    if (direct) {
        if (direct.id !== undefined && direct.id !== MCP_REQUEST_ID) return undefined;
        return readResponse(direct);
    }
    let bound: string | undefined;
    for (const data of parseSseData(body)) {
        const message = parseJsonObject(data) as JsonRpcResponse | undefined;
        if (!message) {
            if (data.trim() === "") continue;
            return undefined;
        }
        if (message.id !== MCP_REQUEST_ID) continue;
        const canonical = JSON.stringify(message);
        if (bound !== undefined && bound !== canonical) return undefined;
        bound = canonical;
    }
    return bound === undefined ? undefined : readResponse(JSON.parse(bound) as JsonRpcResponse);
}

/** A successful MCP envelope can still contain an explicit zero-hit search.
 * Only recognize Parallel's structured result; keep unknown/plain text intact. */
function isEmptyParallelResult(text: string): boolean {
    if (text.trim() === "") return true;
    try {
        const result: unknown = JSON.parse(text);
        return (
            !!result &&
            typeof result === "object" &&
            !Array.isArray(result) &&
            "search_id" in result &&
            typeof result.search_id === "string" &&
            "results" in result &&
            Array.isArray(result.results) &&
            result.results.length === 0
        );
    } catch {
        // error-policy:J3 Non-JSON search text remains complete usable evidence.
        return false;
    }
}

function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
    const at = Date.parse(trimmed);
    return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

async function readTextCapped(
    response: Response,
    maxBytes: number,
    provider: KeylessWebSearchProvider
): Promise<string> {
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (
        contentType &&
        !contentType.startsWith("text/") &&
        !contentType.includes("application/json") &&
        !contentType.includes("text/event-stream")
    ) {
        await response.body?.cancel();
        throw new KeylessWebSearchUnavailableError({
            provider,
            reason: "unsupported_content_type",
        });
    }
    if (!response.body) return "";

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (bytes + value.byteLength > maxBytes) {
                await reader.cancel("keyless web search response exceeded byte limit");
                throw new KeylessWebSearchUnavailableError({
                    provider,
                    reason: "response_too_large",
                });
            }
            bytes += value.byteLength;
            text += decoder.decode(value, { stream: true });
        }
        return text + decoder.decode();
    } finally {
        reader.releaseLock();
    }
}

async function callMcp(
    provider: KeylessWebSearchProvider,
    url: string,
    toolName: string,
    args: Record<string, unknown>,
    options: Required<
        Pick<KeylessWebSearchOptions, "timeoutMs" | "maxResponseBytes" | "fetchImpl">
    > &
        Pick<KeylessWebSearchOptions, "signal">
): Promise<string | undefined> {
    if (options.signal?.aborted) {
        throw new KeylessWebSearchUnavailableError({ provider, reason: "aborted" });
    }
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, options.timeoutMs);
    const onCallerAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const failure = (cause: unknown): KeylessWebSearchUnavailableError =>
        isKeylessWebSearchUnavailableError(cause)
            ? cause
            : new KeylessWebSearchUnavailableError({
                  provider,
                  reason: timedOut ? "timeout" : options.signal?.aborted ? "aborted" : "network",
                  cause,
              });
    try {
        let response: Response;
        try {
            response = await options.fetchImpl(url, {
                method: "POST",
                redirect: "manual",
                signal: controller.signal,
                headers: {
                    Accept: "application/json, text/event-stream",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: MCP_REQUEST_ID,
                    method: "tools/call",
                    params: { name: toolName, arguments: args },
                }),
            });
        } catch (error) {
            // error-policy:J2 transport failures become a typed provider outcome.
            throw failure(error);
        }
        if (!response.ok) {
            await response.body?.cancel();
            throw new KeylessWebSearchUnavailableError({
                provider,
                reason: response.status === 429 ? "rate_limited" : "http_error",
                status: response.status,
                retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
            });
        }
        let body: string;
        try {
            body = await readTextCapped(response, options.maxResponseBytes, provider);
        } catch (error) {
            // error-policy:J2 body-read failures become a typed provider outcome.
            throw failure(error);
        }
        const outcome = parseMcpBody(body);
        if (!outcome) {
            throw new KeylessWebSearchUnavailableError({ provider, reason: "malformed_response" });
        }
        if (outcome.kind === "error") {
            throw new KeylessWebSearchUnavailableError({ provider, reason: outcome.reason });
        }
        return outcome.text;
    } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onCallerAbort);
    }
}

/**
 * Search the public web without credentials. Resolves the complete result
 * text, or `undefined` for a successful zero-hit search; throws
 * `KeylessWebSearchUnavailableError` when the provider could not answer.
 */
export async function searchKeylessWeb(
    query: string,
    options: KeylessWebSearchOptions = {}
): Promise<KeylessWebSearchResult | undefined> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new Error("Web search query is required");

    const transport = {
        fetchImpl:
            options.fetchImpl ??
            ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)),
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxResponseBytes: options.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES,
        signal: options.signal,
    };

    const text = await callMcp(
        "parallel",
        PARALLEL_MCP_URL,
        "web_search",
        { objective: normalizedQuery, search_queries: [normalizedQuery] },
        transport
    );
    if (text === undefined || isEmptyParallelResult(text)) return undefined;

    void options.maxResultChars;
    return {
        provider: "parallel",
        text,
        truncated: false,
    };
}
