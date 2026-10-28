/** Exercises fixed anonymous article-fetch MCP wire, bounds and cancellation with synthetic HTTP. */
import { describe, expect, it, vi } from "vitest";
import { fetchKeylessWeb } from "./keyless-web-search";

function mcp(text: string): Response {
    return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });
}

describe("fetchKeylessWeb", () => {
    it("uses one bounded anonymous web_fetch batch without another search", async () => {
        const payload = JSON.stringify({ extract_id: "extract_fixture", results: [], errors: [] });
        const fetchImpl = vi.fn(async () => mcp(payload));
        const urls = [
            "https://publisher.example/news/tokyo",
            "https://publisher.example/news/japan",
        ];
        const result = await fetchKeylessWeb(urls, { fetchImpl, sessionId: "session_fixture" });
        expect(result?.text).toBe(payload);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [endpoint, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(endpoint).toBe("https://search.parallel.ai/mcp");
        expect(init.redirect).toBe("manual");
        expect(new Headers(init.headers).has("Authorization")).toBe(false);
        const request = JSON.parse(String(init.body));
        expect(request.params.name).toBe("web_fetch");
        expect(request.params.arguments).toMatchObject({
            urls,
            full_content: false,
            session_id: "session_fixture",
        });
        expect(request.params.arguments.objective.length).toBeLessThanOrEqual(200);
        expect(Object.keys(request.params.arguments).sort()).toEqual([
            "full_content",
            "objective",
            "session_id",
            "urls",
        ]);
        await expect(
            fetchKeylessWeb([...urls, "https://publisher.example/news/third"], { fetchImpl })
        ).rejects.toThrow();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    it("refuses redirects and oversized fetch responses without retry", async () => {
        const redirect = vi.fn(
            async () =>
                new Response(null, { status: 302, headers: { Location: "https://other.example/" } })
        );
        await expect(
            fetchKeylessWeb(["https://publisher.example/news/tokyo"], { fetchImpl: redirect })
        ).rejects.toMatchObject({ reason: "http_error", status: 302 });
        expect(redirect).toHaveBeenCalledTimes(1);
        const large = vi.fn(async () => mcp("x".repeat(128)));
        await expect(
            fetchKeylessWeb(["https://publisher.example/news/tokyo"], {
                fetchImpl: large,
                maxResponseBytes: 16,
            })
        ).rejects.toMatchObject({ reason: "response_too_large" });
        expect(large).toHaveBeenCalledTimes(1);
    });
    it("an aborted article read is never dispatched", async () => {
        const abort = new AbortController();
        abort.abort();
        const fetchImpl = vi.fn(async () => mcp("unused"));
        await expect(
            fetchKeylessWeb(["https://publisher.example/news/tokyo"], {
                fetchImpl,
                signal: abort.signal,
            })
        ).rejects.toMatchObject({ reason: "aborted" });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it("retains complete SSE article text and rejects conflicting envelopes", async () => {
        const payload = JSON.stringify({ results: [{ text: `${"a".repeat(20_000)}完整末尾` }] });
        const envelope = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { content: [{ type: "text", text: payload }] },
        });
        const response = (body: string) =>
            new Response(body, { headers: { "Content-Type": "text/event-stream" } });
        const fetchImpl = vi.fn(async () =>
            response(`: heartbeat\ndata: ${envelope}\n\ndata: ${envelope}\n\n`)
        );
        expect(
            (
                await fetchKeylessWeb(["https://publisher.example/article"], {
                    fetchImpl,
                    maxResultChars: 8,
                })
            )?.text
        ).toBe(payload);
        const conflicting = envelope.replace("完整末尾", "different");
        await expect(
            fetchKeylessWeb(["https://publisher.example/article"], {
                fetchImpl: async () => response(`data: ${envelope}\n\ndata: ${conflicting}\n\n`),
            })
        ).rejects.toMatchObject({ reason: "malformed_response" });
    });

    it("uses a five-second default deadline and forwards in-flight cancellation", async () => {
        const timer = vi.spyOn(globalThis, "setTimeout");
        try {
            await fetchKeylessWeb(["https://publisher.example/article"], {
                fetchImpl: async () => mcp("complete"),
            });
            expect(timer.mock.calls.some((call) => call[1] === 5_000)).toBe(true);
        } finally {
            timer.mockRestore();
        }
        const abort = new AbortController();
        let signal: AbortSignal | undefined;
        const pending = fetchKeylessWeb(["https://publisher.example/article"], {
            signal: abort.signal,
            fetchImpl: async (_input, init) => {
                signal = init?.signal ?? undefined;
                return new Promise<Response>((_resolve, reject) => {
                    signal?.addEventListener(
                        "abort",
                        () => reject(new Error("transport cancelled")),
                        { once: true }
                    );
                });
            },
        });
        abort.abort();
        await expect(pending).rejects.toMatchObject({ reason: "aborted" });
        expect(signal?.aborted).toBe(true);
    });

    it("reports the deadline as an outage without retrying", async () => {
        const fetchImpl = vi.fn(
            async (_input: RequestInfo | URL, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => reject(new Error("deadline")), {
                        once: true,
                    });
                })
        );
        await expect(
            fetchKeylessWeb(["https://publisher.example/article"], { fetchImpl, timeoutMs: 1 })
        ).rejects.toMatchObject({ reason: "timeout" });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("rejects noncanonical URLs before dispatch and omits an invalid session", async () => {
        const fetchImpl = vi.fn(async () => mcp("complete"));
        for (const urls of [
            [],
            ["https://publisher.example"],
            ["file:///tmp/article"],
            ["https://user:password@publisher.example/article"],
            ["https://publisher.example/article", "https://publisher.example/article"],
        ]) {
            await expect(fetchKeylessWeb(urls, { fetchImpl })).rejects.toThrow();
        }
        expect(fetchImpl).not.toHaveBeenCalled();
        await fetchKeylessWeb(["https://publisher.example/article"], {
            fetchImpl,
            sessionId: "invalid session",
        });
        const request = JSON.parse(
            String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)
        );
        expect(request.params.arguments.session_id).toBeUndefined();
    });
});
