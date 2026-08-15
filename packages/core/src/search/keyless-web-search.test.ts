/** Exercises the shared keyless-search transport with deterministic Web API responses. */

import { describe, expect, it, vi } from "vitest";
import { searchKeylessWeb } from "./keyless-web-search";

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

	it("falls back to Exa after an unusable Parallel result", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(mcp("", { isError: true }))
			.mockResolvedValueOnce(mcp("fallback result"));
		const result = await searchKeylessWeb("fallback", { fetchImpl });

		expect(result?.provider).toBe("exa");
		expect(result?.text).toBe("fallback result");
		expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://mcp.exa.ai/mcp");
	});

	it("bounds model-visible text", async () => {
		const result = await searchKeylessWeb("large", {
			fetchImpl: async () => mcp("x".repeat(200)),
			maxResultChars: 32,
		});

		expect(result).toEqual({
			provider: "parallel",
			text: `${"x".repeat(32)}\n[truncated]`,
			truncated: true,
		});
	});

	it("rejects oversized response bodies and returns no fabricated result", async () => {
		const result = await searchKeylessWeb("oversized", {
			fetchImpl: async () => mcp("x".repeat(2_000)),
			maxResponseBytes: 100,
		});

		expect(result).toBeUndefined();
	});

	it("falls through aborted providers within the configured deadline", async () => {
		const fetchImpl = vi.fn(
			(_url: string | URL | Request, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				}),
		);
		const started = performance.now();
		const result = await searchKeylessWeb("timeout", {
			fetchImpl,
			timeoutMs: 20,
		});

		expect(result).toBeUndefined();
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(performance.now() - started).toBeLessThan(250);
	});
});
