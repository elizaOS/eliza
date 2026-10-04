import { describe, expect, it, vi } from "vitest";
import { describeImageCached } from "../media/image-description-cache";
import type { IAgentRuntime } from "../types/runtime";

describe("image analysis cache", () => {
	it("reuses identical requests without conflating different prompts", async () => {
		const cache = new Map<string, unknown>();
		const useModel = vi.fn(
			async (_type: unknown, request: { prompt: string }) => request.prompt,
		);
		const runtime = {
			getModelRegistrations: () => [],
			getCache: async (key: string) => cache.get(key),
			setCache: async (key: string, value: unknown) => {
				cache.set(key, value);
			},
			useModel,
			reportError: vi.fn(),
		} as unknown as IAgentRuntime;
		const url = "data:image/png;base64,aGVsbG8=";
		expect(
			(await describeImageCached(runtime, url, "Describe colors"))?.text,
		).toBe("Describe colors");
		expect((await describeImageCached(runtime, url, "Read text"))?.text).toBe(
			"Read text",
		);
		expect(
			(await describeImageCached(runtime, url, "Describe colors"))?.text,
		).toBe("Describe colors");
		expect(useModel).toHaveBeenCalledTimes(2);
	});
	it("reanalyzes mutable remote URLs instead of serving stale content", async () => {
		const runtime = {
			getModelRegistrations: () => [],
			getCache: vi.fn(),
			setCache: vi.fn(),
			useModel: vi
				.fn()
				.mockResolvedValueOnce("First image")
				.mockResolvedValueOnce("Changed image"),
			reportError: vi.fn(),
		} as unknown as IAgentRuntime;
		const url = "https://example.com/current.png";
		expect((await describeImageCached(runtime, url, "Describe"))?.text).toBe(
			"First image",
		);
		expect((await describeImageCached(runtime, url, "Describe"))?.text).toBe(
			"Changed image",
		);
		expect(runtime.getCache).not.toHaveBeenCalled();
		expect(runtime.setCache).not.toHaveBeenCalled();
	});
	it("invalidates immutable-media analysis when declared provider/model configuration changes", async () => {
		const cache = new Map<string, unknown>();
		let provider = "vision-a";
		let model = "model-1";
		const useModel = vi.fn(async () => `${provider}:${model}`);
		const runtime = {
			getModelRegistrations: () => [
				{
					modelType: "IMAGE_DESCRIPTION",
					provider,
					priority: 0,
					registrationOrder: 1,
					metadata: { displayModelSetting: "VISION_MODEL" },
				},
			],
			getSetting: () => model,
			getCache: async (key: string) => cache.get(key),
			setCache: async (key: string, value: unknown) => {
				cache.set(key, value);
			},
			useModel,
			reportError: vi.fn(),
		} as unknown as IAgentRuntime;
		const url = "data:image/png;base64,aGVsbG8=";
		expect((await describeImageCached(runtime, url, "Read"))?.text).toBe(
			"vision-a:model-1",
		);
		model = "model-2";
		expect((await describeImageCached(runtime, url, "Read"))?.text).toBe(
			"vision-a:model-2",
		);
		provider = "vision-b";
		expect((await describeImageCached(runtime, url, "Read"))?.text).toBe(
			"vision-b:model-2",
		);
		await describeImageCached(runtime, url, "Read");
		expect(useModel).toHaveBeenCalledTimes(3);
	});
});
