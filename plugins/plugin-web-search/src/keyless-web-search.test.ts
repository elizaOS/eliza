/** Exercises the shared keyless-search transport with deterministic Web API responses. */

import { describe, expect, it, vi } from "vitest";
import { KeylessWebSearchUnavailableError, searchKeylessWeb } from "./keyless-web-search";

function mcp(text: string, options?: { isError?: boolean }): Response {
    return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
            isError: options?.isError,
            content: [{ type: "text", text }],
        },
    });
}

describe("searchKeylessWeb", () => {
    it.each([JSON.stringify({ search_id: "empty", results: [] }), ""])(
        "reports a successful empty search without another provider when Parallel returns %s",
        async (text) => {
            const fetchImpl = vi.fn(async () => mcp(text));
            expect(await searchKeylessWeb("current price", { fetchImpl })).toBeUndefined();
            expect(fetchImpl).toHaveBeenCalledTimes(1);
        }
    );
    it.each([
        '{"search_id":"hit","results":[{"url":"https://example.com"}]}',
        '{"results":[]}',
        "[]",
        "No parser assumptions about this plain text",
    ])("preserves complete nonempty or unknown search shapes: %s", async (text) => {
        const fetchImpl = vi.fn(async () => mcp(text));
        expect((await searchKeylessWeb("query", { fetchImpl }))?.text).toBe(text);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    it("preserves every MCP text block instead of only the first", async () => {
        const fetchImpl = vi.fn(async () =>
            Response.json({
                result: {
                    content: [
                        { type: "text", text: "First complete source" },
                        { type: "text", text: "Second complete source" },
                    ],
                },
            })
        );
        expect((await searchKeylessWeb("query", { fetchImpl }))?.text).toBe(
            "First complete source\nSecond complete source"
        );
    });

    it("uses Parallel with a fixed non-redirecting MCP request", async () => {
        const fetchImpl = vi.fn(async () => mcp("current result"));
        const result = await searchKeylessWeb("latest elizaOS", { fetchImpl });

        expect(result).toEqual({
            provider: "parallel",
            text: "current result",
            truncated: false,
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0] ?? [];
        expect(url).toBe("https://search.parallel.ai/mcp");
        expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    });

    it("reports provider errors as unavailable without dispatching a fallback", async () => {
        const fetchImpl = vi.fn(async () => mcp("provider error", { isError: true }));
        await expect(searchKeylessWeb("query", { fetchImpl })).rejects.toMatchObject({
            code: "WEB_SEARCH_UNAVAILABLE",
            reason: "provider_error",
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("preserves complete model-visible text", async () => {
        const result = await searchKeylessWeb("large", {
            fetchImpl: async () => mcp("x".repeat(200)),
            maxResultChars: 32,
        });

        expect(result).toEqual({
            provider: "parallel",
            text: "x".repeat(200),
            truncated: false,
        });
    });

    it("ignores legacy result budgets and keeps Unicode well formed", async () => {
        const tiny = await searchKeylessWeb("tiny", {
            fetchImpl: async () => mcp("long result"),
            maxResultChars: 5,
        });
        expect(tiny?.text).toBe("long result");

        const unicode = await searchKeylessWeb("unicode", {
            fetchImpl: async () => mcp(`${"x".repeat(19)}🤖${"y".repeat(20)}`),
            maxResultChars: 32,
        });
        expect(unicode?.text).toBe(`${"x".repeat(19)}🤖${"y".repeat(20)}`);
        expect(unicode?.text?.isWellFormed()).toBe(true);
    });

    it("ignores invalid legacy result budgets and still returns the full result", async () => {
        for (const maxResultChars of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            await expect(
                searchKeylessWeb("invalid budget", {
                    fetchImpl: async () => mcp("long result"),
                    maxResultChars,
                })
            ).resolves.toMatchObject({ text: "long result", truncated: false });
        }

        const zero = await searchKeylessWeb("zero budget", {
            fetchImpl: async () => mcp("long result"),
            maxResultChars: 0,
        });
        expect(zero).toEqual({
            provider: "parallel",
            text: "long result",
            truncated: false,
        });
    });

    it("rejects oversized response bodies as unavailable, not empty", async () => {
        await expect(
            searchKeylessWeb("oversized", {
                fetchImpl: async () => mcp("x".repeat(2_000)),
                maxResponseBytes: 100,
            })
        ).rejects.toMatchObject({ reason: "response_too_large" });
    });

    it("reports an aborted provider within the configured deadline", async () => {
        const fetchImpl = vi.fn(
            (_url: string | URL | Request, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () =>
                        reject(new DOMException("aborted", "AbortError"))
                    );
                })
        );
        const started = performance.now();
        await expect(
            searchKeylessWeb("timeout", {
                fetchImpl,
                timeoutMs: 20,
            })
        ).rejects.toMatchObject({ reason: "timeout" });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(performance.now() - started).toBeLessThan(250);
    });
    it.each([
        [429, "rate_limited"],
        [403, "http_error"],
        [503, "http_error"],
    ] as const)(
        "reports HTTP %i as %s with Retry-After and no query text",
        async (status, reason) => {
            const fetchImpl = vi.fn(
                async () =>
                    new Response("secret provider payload", {
                        status,
                        headers: { "retry-after": "7" },
                    })
            );
            const error = await searchKeylessWeb("private query text", { fetchImpl }).catch(
                (e: unknown) => e
            );
            expect(error).toBeInstanceOf(KeylessWebSearchUnavailableError);
            expect(error).toMatchObject({
                provider: "parallel",
                reason,
                status,
                retryAfterMs: 7000,
            });
            expect(String((error as Error).message)).not.toContain("private query text");
            expect(String((error as Error).message)).not.toContain("secret provider payload");
        }
    );

    it.each([
        ["not json", "text/plain"],
        ['{"jsonrpc":"2.0","id":1,"result":{}}', "application/json"],
        ['{"jsonrpc":"2.0","id":2,"result":{"content":[{"text":"x"}]}}', "application/json"],
    ])("reports a malformed payload as unavailable: %s", async (body, contentType) => {
        const fetchImpl = vi.fn(
            async () => new Response(body, { headers: { "content-type": contentType } })
        );
        await expect(searchKeylessWeb("query", { fetchImpl })).rejects.toMatchObject({
            reason: "malformed_response",
        });
    });

    it("reports a transport failure as unavailable", async () => {
        const fetchImpl = vi.fn(async () => {
            throw new TypeError("fetch failed");
        });
        await expect(searchKeylessWeb("query", { fetchImpl })).rejects.toMatchObject({
            reason: "network",
        });
    });

    it("does not dispatch when the caller already cancelled", async () => {
        const fetchImpl = vi.fn(async () => mcp("result"));
        const controller = new AbortController();
        controller.abort();
        await expect(
            searchKeylessWeb("query", { fetchImpl, signal: controller.signal })
        ).rejects.toMatchObject({ reason: "aborted" });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("aborts an in-flight dispatch when the caller cancels", async () => {
        const controller = new AbortController();
        const fetchImpl = vi.fn(
            (_url: string | URL | Request, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () =>
                        reject(new DOMException("aborted", "AbortError"))
                    );
                    queueMicrotask(() => controller.abort());
                })
        );
        await expect(
            searchKeylessWeb("query", { fetchImpl, signal: controller.signal })
        ).rejects.toMatchObject({ reason: "aborted" });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    describe("SSE response binding", () => {
        const response = (id: number, text: string) =>
            JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
        const sse = (body: string) =>
            new Response(body, { headers: { "content-type": "text/event-stream" } });

        it("skips notifications and other ids and keeps long Unicode text", async () => {
            const text = `${"résumé 🤖 ".repeat(500)}end`;
            const body = [
                `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}`,
                "",
                `data: ${response(7, "unrelated")}`,
                "",
                `data:${response(1, text)}`,
                "",
            ].join("\n");
            const result = await searchKeylessWeb("query", { fetchImpl: async () => sse(body) });
            expect(result?.text).toBe(text);
        });

        it("joins multi-line data fields into one event", async () => {
            const json = response(1, "multi line result");
            const middle = json.indexOf(",");
            const body = `data: ${json.slice(0, middle + 1)}\ndata: ${json.slice(middle + 1)}\n\n`;
            const result = await searchKeylessWeb("query", { fetchImpl: async () => sse(body) });
            expect(result?.text).toBe("multi line result");
        });

        it("collapses identical replays and rejects conflicting responses", async () => {
            const same = `data: ${response(1, "a")}\n\ndata: ${response(1, "a")}\n\n`;
            expect(
                (await searchKeylessWeb("query", { fetchImpl: async () => sse(same) }))?.text
            ).toBe("a");
            const conflicting = `data: ${response(1, "a")}\n\ndata: ${response(1, "b")}\n\n`;
            await expect(
                searchKeylessWeb("query", { fetchImpl: async () => sse(conflicting) })
            ).rejects.toMatchObject({ reason: "malformed_response" });
        });

        it("reports a stream without our response as unavailable", async () => {
            const body = `data: ${response(2, "other")}\n\n`;
            await expect(
                searchKeylessWeb("query", { fetchImpl: async () => sse(body) })
            ).rejects.toMatchObject({ reason: "malformed_response" });
        });
    });
});
