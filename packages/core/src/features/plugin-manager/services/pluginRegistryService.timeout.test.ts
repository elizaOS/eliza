/**
 * Plugin registry fetch timeout: every external fetch must be bounded and the
 * same signal must remain active through response.json() so a stalled body is
 * still aborted. Caller cancellation is composed via AbortSignal.any.
 * Deterministic: real fetchGeneratedRegistry with injected fetch + real AbortSignal.timeout(10ms).
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ElizaError } from "../../../errors.ts";

import {
	DEFAULT_PLUGIN_REGISTRY_FETCH_TIMEOUT_MS,
	fetchGeneratedRegistry,
	resetRegistryCache,
} from "./pluginRegistryService.ts";

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

function stalledJsonResponse(signal?: AbortSignal): Response {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		json: () =>
			stallUntilAborted(signal).then(
				() => ({ registry: {}, lastUpdatedAt: "2026-08-19" }) as never,
			),
		headers: new Headers(),
	} as unknown as Response;
}

function makeRegistryResponse(
	registry: Record<string, unknown> = {
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
): Response {
	return new Response(
		JSON.stringify({ registry, lastUpdatedAt: "2026-08-19T00:00:00Z" }),
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
		},
	);
}

afterEach(() => {
	vi.restoreAllMocks();
	resetRegistryCache();
});

describe("pluginRegistryService fetch timeout", () => {
	it("exposes DEFAULT_PLUGIN_REGISTRY_FETCH_TIMEOUT_MS === 10_000", () => {
		expect(DEFAULT_PLUGIN_REGISTRY_FETCH_TIMEOUT_MS).toBe(10_000);
	});

	it("passes AbortSignal.timeout budget to fetch (hanging fetch → ElizaError PLUGIN_REGISTRY_FETCH_TIMEOUT)", async () => {
		const origTimeout = AbortSignal.timeout.bind(AbortSignal);
		const timeoutSpy = vi
			.spyOn(AbortSignal, "timeout")
			.mockImplementation((_ms: number) => origTimeout(10));

		const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) =>
			stallUntilAborted(init?.signal),
		);

		let caught: unknown;
		await expect(
			fetchGeneratedRegistry({
				fetchImpl: fetchSpy as unknown as typeof fetch,
			}),
		).rejects.toMatchObject({
			name: "ElizaError",
			code: "PLUGIN_REGISTRY_FETCH_TIMEOUT",
		});
		// verify preserved cause is TimeoutError and not raw TimeoutError escaping unwrapped
		try {
			await fetchGeneratedRegistry({
				fetchImpl: fetchSpy as unknown as typeof fetch,
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ElizaError);
		expect((caught as ElizaError).code).toBe(
			"PLUGIN_REGISTRY_FETCH_TIMEOUT",
		);
		expect((caught as ElizaError).cause).toMatchObject({
			name: "TimeoutError",
		});

		expect(timeoutSpy).toHaveBeenCalledWith(
			DEFAULT_PLUGIN_REGISTRY_FETCH_TIMEOUT_MS,
		);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const init = fetchSpy.mock.calls[0][1] as RequestInit;
		expect(init.signal).toBeDefined();
		expect(init.signal?.aborted).toBe(true);
	});

	it("aborts stalled response.json() body via same timeout signal → ElizaError", async () => {
		const origTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, "timeout").mockImplementation((_ms: number) =>
			origTimeout(10),
		);

		const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) =>
			stalledJsonResponse(init?.signal),
		);

		await expect(
			fetchGeneratedRegistry({
				fetchImpl: fetchSpy as unknown as typeof fetch,
			}),
		).rejects.toMatchObject({
			name: "ElizaError",
			code: "PLUGIN_REGISTRY_FETCH_TIMEOUT",
		});
		// raw TimeoutError must not escape
		let err: unknown;
		try {
			await fetchGeneratedRegistry({
				fetchImpl: fetchSpy as unknown as typeof fetch,
			});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(ElizaError);
		expect((err as ElizaError).cause).toMatchObject({ name: "TimeoutError" });
	});

	it("merges caller signal via AbortSignal.any when provided and retains AbortError identity", async () => {
		const origTimeout = AbortSignal.timeout.bind(AbortSignal);
		const timeoutSpy = vi
			.spyOn(AbortSignal, "timeout")
			.mockImplementation((_ms: number) => origTimeout(10));
		const anySpy = vi.spyOn(AbortSignal, "any");

		const callerCtrl = new AbortController();
		const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) =>
			stallUntilAborted(init?.signal),
		);

		const pending = fetchGeneratedRegistry({
			fetchImpl: fetchSpy as unknown as typeof fetch,
			signal: callerCtrl.signal,
		});

		callerCtrl.abort(new DOMException("caller abort", "AbortError"));

		const err = await pending.catch((e: unknown) => e);
		// caller AbortError must not be wrapped into ElizaError
		expect(err).toMatchObject({ name: "AbortError" });
		expect(err).not.toBeInstanceOf(ElizaError);
		expect(timeoutSpy).toHaveBeenCalledWith(
			DEFAULT_PLUGIN_REGISTRY_FETCH_TIMEOUT_MS,
		);
		expect(anySpy).toHaveBeenCalled();
		const anyArgs = anySpy.mock.calls[0][0] as AbortSignal[];
		expect(anyArgs).toHaveLength(2);
		expect(anyArgs[0]).toBe(callerCtrl.signal);
	});

	it("succeeds when fetch returns valid registry within budget", async () => {
		const fetchSpy = vi.fn().mockResolvedValue(makeRegistryResponse());
		const plugins = await fetchGeneratedRegistry({
			fetchImpl: fetchSpy as unknown as typeof fetch,
		});
		expect(plugins.size).toBe(1);
		expect(plugins.get("@elizaos/test-plugin")?.description).toBe("test");
	});

	it("terminates stalled real HTTP body (headers + partial JSON) at deadline via loopback and does not cache", async () => {
		// Real transport test: proves AbortSignal.timeout + fetch + response.json() body
		// stall is bounded on a real socket, not just an injected promise listening to signal.
		const server = createServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			// Emit headers + partial body then stall forever without ending
			res.write('{"registry":{');
			// intentionally not calling res.end() — client must timeout
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", () => resolve()),
		);
		const addr = server.address() as AddressInfo;
		const loopbackUrl = `http://127.0.0.1:${addr.port}/generated-registry.json`;

		// fetchImpl delegates to real fetch against loopback but honors the passed signal
		const loopbackFetch: typeof fetch = (_input, init) =>
			fetch(loopbackUrl, { signal: init?.signal });

		const timeoutMs = 400;

		try {
			const start = Date.now();
			const first = await fetchGeneratedRegistry({
				fetchImpl: loopbackFetch,
				timeoutMs,
			}).catch((e: unknown) => e);
			const elapsed = Date.now() - start;

			expect(first).toBeInstanceOf(ElizaError);
			expect((first as ElizaError).code).toBe(
				"PLUGIN_REGISTRY_FETCH_TIMEOUT",
			);
			expect((first as ElizaError).cause).toMatchObject({
				name: "TimeoutError",
			});
			// Must have terminated near the deadline, not hung
			expect(elapsed).toBeGreaterThanOrEqual(300);
			expect(elapsed).toBeLessThan(3000);

			// Second call must also timeout — proves failure was not cached as a successful registry
			const second = await fetchGeneratedRegistry({
				fetchImpl: loopbackFetch,
				timeoutMs,
			}).catch((e: unknown) => e);
			expect(second).toBeInstanceOf(ElizaError);
			expect((second as ElizaError).code).toBe(
				"PLUGIN_REGISTRY_FETCH_TIMEOUT",
			);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
