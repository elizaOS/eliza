/**
 * Exercises plugin-registry request deadlines through the public load path.
 * The suite uses real AbortSignal deadlines and a loopback HTTP body stall;
 * global fetch replacement is confined to the test harness.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ElizaError } from "../../../errors.ts";
import { loadRegistry, resetRegistryCache } from "./pluginRegistryService.ts";

const originalFetch = globalThis.fetch.bind(globalThis);

function stallUntilAborted(signal?: AbortSignal): Promise<Response> {
	return new Promise<Response>((_resolve, reject) => {
		if (!signal) return;
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		signal.addEventListener("abort", () => reject(signal.reason), {
			once: true,
		});
	});
}

function makeRegistryResponse(): Response {
	return new Response(
		JSON.stringify({
			lastUpdatedAt: "2026-08-19T00:00:00Z",
			registry: {
				"@elizaos/test-plugin": {
					git: {
						repo: "elizaOS/test-plugin",
						v0: { version: null, branch: null },
						v1: { version: null, branch: null },
						v2: { version: "1.0.0", branch: "main" },
					},
					npm: {
						repo: "@elizaos/test-plugin",
						v0: null,
						v1: null,
						v2: "1.0.0",
						v0CoreRange: null,
						v1CoreRange: null,
						v2CoreRange: null,
					},
					supports: { v0: false, v1: true, v2: true },
					description: "test",
					homepage: null,
					topics: [],
					stargazers_count: 5,
					language: "TypeScript",
				},
			},
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	resetRegistryCache();
});

describe("pluginRegistryService fetch timeout", () => {
	it("bounds a hanging request and preserves the platform timeout as cause", async () => {
		const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
		const timeoutSpy = vi
			.spyOn(AbortSignal, "timeout")
			.mockImplementation(() => originalTimeout(10));
		const fetchSpy = vi.fn((_url: string, init?: RequestInit) =>
			stallUntilAborted(init?.signal),
		);
		vi.stubGlobal("fetch", fetchSpy);

		const error = await loadRegistry().catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ElizaError);
		expect((error as ElizaError).code).toBe("PLUGIN_REGISTRY_FETCH_TIMEOUT");
		expect((error as ElizaError).cause).toMatchObject({ name: "TimeoutError" });
		expect(timeoutSpy).toHaveBeenCalledWith(10_000);
		expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
	});

	it("preserves a non-timeout AbortError identity", async () => {
		const abort = new DOMException("caller cancelled", "AbortError");
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));

		const error = await loadRegistry().catch((cause: unknown) => cause);

		expect(error).toBe(abort);
		expect(error).not.toBeInstanceOf(ElizaError);
	});

	it("caches only a successful registry response", async () => {
		const fetchSpy = vi.fn().mockResolvedValue(makeRegistryResponse());
		vi.stubGlobal("fetch", fetchSpy);

		const first = await loadRegistry();
		const second = await loadRegistry();

		expect(first.get("@elizaos/test-plugin")?.description).toBe("test");
		expect(second).toBe(first);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("translates non-success responses to a typed HTTP error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response("unavailable", {
					status: 503,
					statusText: "Service Unavailable",
				}),
			),
		);

		await expect(loadRegistry()).rejects.toMatchObject({
			name: "ElizaError",
			code: "PLUGIN_REGISTRY_FETCH_HTTP_ERROR",
			context: { status: 503 },
		});
	});

	it("translates malformed JSON without disguising it as a timeout", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response("{", {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);

		const error = await loadRegistry().catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ElizaError);
		expect((error as ElizaError).code).toBe("PLUGIN_REGISTRY_RESPONSE_INVALID");
		expect((error as ElizaError).cause).toBeInstanceOf(SyntaxError);
	});

	it("preserves AbortError identity when response body consumption aborts", async () => {
		const abort = new DOMException("body cancelled", "AbortError");
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(abort);
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(body, {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);

		const error = await loadRegistry().catch((cause: unknown) => cause);

		expect(error).toBe(abort);
		expect(error).not.toBeInstanceOf(ElizaError);
	});

	it("terminates a real headers-plus-partial-body stall and does not cache it", async () => {
		const server = createServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.write('{"registry":{');
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const { port } = server.address() as AddressInfo;
		const loopbackUrl = `http://127.0.0.1:${port}/generated-registry.json`;
		const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
			originalTimeout(400),
		);
		const fetchSpy = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
			originalFetch(loopbackUrl, { signal: init?.signal }),
		);
		vi.stubGlobal("fetch", fetchSpy);

		try {
			const startedAt = Date.now();
			const first = await loadRegistry().catch((cause: unknown) => cause);
			const elapsedMs = Date.now() - startedAt;
			expect(first).toMatchObject({
				name: "ElizaError",
				code: "PLUGIN_REGISTRY_FETCH_TIMEOUT",
			});
			expect(elapsedMs).toBeGreaterThanOrEqual(300);
			expect(elapsedMs).toBeLessThan(3_000);

			const second = await loadRegistry().catch((cause: unknown) => cause);
			expect(second).toMatchObject({
				name: "ElizaError",
				code: "PLUGIN_REGISTRY_FETCH_TIMEOUT",
			});
			expect(fetchSpy).toHaveBeenCalledTimes(2);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
