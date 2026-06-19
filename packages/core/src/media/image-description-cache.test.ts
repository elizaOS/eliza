import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "../types/index.ts";
import {
	describeImageCached,
	imageDescriptionCacheKey,
	normalizeImageDescription,
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
	const runtime = {
		getCache: vi.fn(async (key: string) => store.get(key)),
		setCache,
		useModel,
		logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
	} as unknown as IAgentRuntime;
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
