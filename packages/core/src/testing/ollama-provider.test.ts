/**
 * Unit tests for the Ollama testing provider.
 *
 * `fetch` is stubbed so `isOllamaAvailable` is exercised deterministically:
 * calling it for real reaches `${OLLAMA_URL}/api/tags` with a 5s timeout, which
 * makes the result depend on whether a daemon happens to be running on the
 * machine — and since the function catches everything and returns `false`,
 * asserting only that it returns a boolean cannot fail.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelType } from "../types";
import {
	createOllamaModelHandlers,
	isOllamaAvailable,
} from "./ollama-provider.ts";

describe("ollama-provider", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("registers a handler for each supported model type", () => {
		const handlers = createOllamaModelHandlers();
		expect(typeof handlers[ModelType.TEXT_SMALL]).toBe("function");
		expect(typeof handlers[ModelType.TEXT_LARGE]).toBe("function");
		expect(typeof handlers[ModelType.TEXT_EMBEDDING]).toBe("function");
	});

	it("reports available when the tags endpoint answers ok", async () => {
		const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(isOllamaAvailable()).resolves.toBe(true);
		// The probe must be the tags endpoint, and must carry an abort signal so a
		// hung daemon cannot pin the caller.
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toMatch(/\/api\/tags$/);
		expect(init.method).toBe("GET");
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("reports unavailable on a non-ok status", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 503 })),
		);
		await expect(isOllamaAvailable()).resolves.toBe(false);
	});

	it("reports unavailable instead of throwing when the probe fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("connection refused");
			}),
		);
		await expect(isOllamaAvailable()).resolves.toBe(false);
	});
});
