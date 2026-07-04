/**
 * Tests for the shared image-description cache helpers — cache key, response
 * normalization, and the cached describe path (hit reuse, miss-then-cache,
 * error/empty-URL fallbacks, and reportError surfacing on a broken cache).
 * Deterministic: `createMockRuntime` backs the cache with an in-memory Map and
 * stubs `useModel`; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../testing/mock-runtime";
import type { IAgentRuntime } from "../types/index.ts";
import {
	describeImageCached,
	getCachedImageDescription,
	imageDescriptionCacheKey,
	normalizeImageDescription,
	setCachedImageDescription,
} from "./image-description-cache.ts";

function fakeRuntime(overrides: {
	cache?: Record<string, unknown>;
	useModel?: ReturnType<typeof vi.fn>;
}): {
	runtime: IAgentRuntime;
	useModel: ReturnType<typeof vi.fn>;
	setCache: ReturnType<typeof vi.fn>;
} {
	const store = new Map<string, unknown>(Object.entries(overrides.cache ?? {}));
	const useModel = overrides.useModel ?? vi.fn();
	const setCache = vi.fn(async (key: string, value: unknown) => {
		store.set(key, value);
		return true;
	});
	const runtime = createMockRuntime({
		getCache: vi.fn(async (key: string) => store.get(key)),
		setCache,
		useModel,
		logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
	});
	return { runtime, useModel, setCache };
}

describe("imageDescriptionCacheKey", () => {
	it("is deterministic and content-sensitive", () => {
		expect(imageDescriptionCacheKey("data:image/png;base64,AAAA")).toBe(
			imageDescriptionCacheKey("data:image/png;base64,AAAA"),
		);
		expect(imageDescriptionCacheKey("a")).not.toBe(
			imageDescriptionCacheKey("b"),
		);
		expect(imageDescriptionCacheKey("x")).toMatch(/^img-desc:v1:[a-f0-9]{8}$/);
	});
});

describe("normalizeImageDescription", () => {
	it("parses a JSON string response", () => {
		expect(
			normalizeImageDescription('{"title":"Cat","description":"a cat"}'),
		).toEqual({ title: "Cat", description: "a cat", text: "a cat" });
	});
	it("treats a plain string as the description", () => {
		expect(normalizeImageDescription("just text")).toEqual({
			title: "Image",
			description: "just text",
			text: "just text",
		});
	});
	it("reads an object response", () => {
		expect(normalizeImageDescription({ description: "d" })).toEqual({
			title: "Image",
			description: "d",
			text: "d",
		});
	});
	it("returns null for empty / unusable responses", () => {
		expect(normalizeImageDescription("")).toBeNull();
		expect(normalizeImageDescription({})).toBeNull();
		expect(normalizeImageDescription(null)).toBeNull();
	});
});

describe("describeImageCached", () => {
	it("returns the cached description without calling the model", async () => {
		const key = imageDescriptionCacheKey("https://x/cat.png");
		const { runtime, useModel } = fakeRuntime({
			cache: { [key]: { title: "Cat", description: "cached", text: "cached" } },
		});
		const result = await describeImageCached(
			runtime,
			"https://x/cat.png",
			"prompt",
		);
		expect(result).toEqual({
			title: "Cat",
			description: "cached",
			text: "cached",
		});
		expect(useModel).not.toHaveBeenCalled();
	});

	it("calls the model on a miss, then caches the result", async () => {
		const useModel = vi.fn(async () => '{"title":"Dog","description":"a dog"}');
		const { runtime, setCache } = fakeRuntime({ useModel });
		const result = await describeImageCached(
			runtime,
			"https://x/dog.png",
			"prompt",
		);
		expect(useModel).toHaveBeenCalledTimes(1);
		expect(result?.description).toBe("a dog");
		expect(setCache).toHaveBeenCalledWith(
			imageDescriptionCacheKey("https://x/dog.png"),
			{ title: "Dog", description: "a dog", text: "a dog" },
		);
	});

	it("returns null and does not throw when the model errors", async () => {
		const useModel = vi.fn(async () => {
			throw new Error("vision down");
		});
		const { runtime, setCache } = fakeRuntime({ useModel });
		const result = await describeImageCached(runtime, "https://x/e.png", "p");
		expect(result).toBeNull();
		expect(setCache).not.toHaveBeenCalled();
	});

	it("returns null for an empty URL without calling the model", async () => {
		const { runtime, useModel } = fakeRuntime({});
		expect(await describeImageCached(runtime, "  ", "p")).toBeNull();
		expect(useModel).not.toHaveBeenCalled();
	});
});

// Real-error-path coverage for the #12264 fast-fail sweep: a broken cache must
// surface via runtime.reportError, not vanish. The dependency is broken for
// real (a rejecting getCache/setCache), and the assertion is that the failure
// is reported — never that a fabricated default was returned silently.
describe("image cache failures surface via reportError", () => {
	it("reports a read failure and degrades to a cache miss (undefined)", async () => {
		const reportError = vi.fn();
		const runtime = createMockRuntime({
			getCache: vi.fn(async () => {
				throw new Error("cache read exploded");
			}),
			reportError,
		});
		const result = await getCachedImageDescription(runtime, "https://x/a.png");
		expect(result).toBeUndefined();
		expect(reportError).toHaveBeenCalledTimes(1);
		expect(reportError).toHaveBeenCalledWith(
			"ImageDescriptionCache.get",
			expect.any(Error),
			{ imageUrl: "https://x/a.png" },
		);
	});

	it("reports a write failure without throwing", async () => {
		const reportError = vi.fn();
		const runtime = createMockRuntime({
			setCache: vi.fn(async () => {
				throw new Error("cache write exploded");
			}),
			reportError,
		});
		await expect(
			setCachedImageDescription(runtime, "https://x/b.png", {
				title: "B",
				description: "d",
				text: "d",
			}),
		).resolves.toBeUndefined();
		expect(reportError).toHaveBeenCalledTimes(1);
		expect(reportError).toHaveBeenCalledWith(
			"ImageDescriptionCache.set",
			expect.any(Error),
			{ imageUrl: "https://x/b.png" },
		);
	});
});
