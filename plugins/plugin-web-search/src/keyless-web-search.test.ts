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
	it("uses Parallel first with a fixed non-redirecting MCP request", async () => {
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
		expect(String(init?.body)).not.toContain("TAVILY");
	});

	it("reports Parallel provider failure without dispatching another provider", async () => {
        const fetchImpl = vi.fn(async () => mcp("", { isError: true }));
        await expect(searchKeylessWeb("fallback", { fetchImpl })).rejects.toMatchObject({
            name: "KeylessWebSearchUnavailableError", provider: "parallel", reason: "provider_error",
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
		for (const maxResultChars of [
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			await expect(
				searchKeylessWeb("invalid budget", {
					fetchImpl: async () => mcp("long result"),
					maxResultChars,
				}),
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

	it("rejects oversized response bodies as unavailable rather than zero-hit success", async () => {
        await expect(searchKeylessWeb("oversized", {
            fetchImpl: async () => mcp("x".repeat(2_000)), maxResponseBytes: 100,
        })).rejects.toMatchObject({ reason: "response_too_large" });
    });

	it("reports the one provider timeout within the configured deadline", async () => {
		const fetchImpl = vi.fn(
			(_url: string | URL | Request, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				}),
		);
		const started = performance.now();
        await expect(searchKeylessWeb("timeout", { fetchImpl, timeoutMs: 20 })).rejects.toMatchObject({ reason: "timeout" });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(performance.now() - started).toBeLessThan(250);
	});
});

it("successful zero-hit result is empty without any provider fallback", async () => {
  for (const text of ["", JSON.stringify({ search_id: "empty", results: [] })]) {
    const fetchImpl = vi.fn(async () => mcp(text));
    expect(await searchKeylessWeb("empty", { fetchImpl })).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  }
});
it("rate limit remains a typed finite failure with retry metadata", async () => {
  const fetchImpl = vi.fn(async () => new Response("not logged", { status: 429, headers: { "Retry-After": "2" } }));
  await expect(searchKeylessWeb("private-query-canary", { fetchImpl })).rejects.toMatchObject({
    code: "WEB_SEARCH_UNAVAILABLE", provider: "parallel", reason: "rate_limited", status: 429, retryAfterMs: 2000,
  });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it("caller abort prevents dispatch and cancels an in-flight provider request", async () => {
  const stopped = new AbortController(); stopped.abort();
  const notCalled = vi.fn(async () => mcp("must not dispatch"));
  await expect(searchKeylessWeb("cancelled", { signal: stopped.signal, fetchImpl: notCalled })).rejects.toBeInstanceOf(KeylessWebSearchUnavailableError);
  expect(notCalled).not.toHaveBeenCalled();
  const controller = new AbortController();
  const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    queueMicrotask(() => controller.abort());
  }));
  await expect(searchKeylessWeb("cancelled", { signal: controller.signal, fetchImpl })).rejects.toMatchObject({ reason: "aborted" });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
