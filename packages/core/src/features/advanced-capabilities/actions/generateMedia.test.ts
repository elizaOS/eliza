import { describe, expect, it, vi } from "vitest";
import { ModelType, ServiceType } from "../../../types/index.ts";
import { generateMediaAction } from "./generateMedia.ts";

const message = {
	id: "msg",
	roomId: "room",
	content: { text: "generate an image of a glass lighthouse" },
} as never;

function runtimeWithMediaService(
	canGenerateMedia: boolean,
	generateMedia = vi.fn(),
) {
	return {
		getService: (serviceType: string) =>
			serviceType === ServiceType.MEDIA_GENERATION
				? { canGenerateMedia: vi.fn(() => canGenerateMedia), generateMedia }
				: undefined,
		getModel: vi.fn(() => undefined),
	} as never;
}

describe("generateMediaAction availability", () => {
	it("is hidden when the media service reports no configured provider", async () => {
		await expect(
			generateMediaAction.validate?.(
				runtimeWithMediaService(false),
				message,
				undefined,
				{ parameters: { mediaType: "image", prompt: "glass lighthouse" } },
			),
		).resolves.toBe(false);
	});

	it("allows image fallback when an IMAGE model is registered", async () => {
		const runtime = {
			getService: () => undefined,
			getModel: (modelType: string) =>
				modelType === ModelType.IMAGE ? vi.fn() : undefined,
		} as never;

		await expect(
			generateMediaAction.validate?.(runtime, message, undefined, {
				parameters: { mediaType: "image", prompt: "glass lighthouse" },
			}),
		).resolves.toBe(true);
	});

	it("is hidden for video when no media service is configured", async () => {
		const runtime = {
			getService: () => undefined,
			getModel: vi.fn(() => undefined),
		} as never;

		await expect(
			generateMediaAction.validate?.(runtime, message, undefined, {
				parameters: { mediaType: "video", prompt: "glass lighthouse" },
			}),
		).resolves.toBe(false);
	});

	it("allows video when the media service can generate video", async () => {
		await expect(
			generateMediaAction.validate?.(
				runtimeWithMediaService(true),
				message,
				undefined,
				{ parameters: { mediaType: "video", prompt: "glass lighthouse" } },
			),
		).resolves.toBe(true);
	});

	it("returns MEDIA_GENERATION_MISSING_URL when video service omits videoUrl", async () => {
		const generateMedia = vi.fn(async () => ({
			mediaType: "video",
			url: undefined,
			videoUrl: undefined,
			mimeType: "video/mp4",
		}));
		const result = await generateMediaAction.handler?.(
			runtimeWithMediaService(true, generateMedia),
			message,
			undefined,
			{ parameters: { mediaType: "video", prompt: "glass lighthouse" } },
		);

		expect(result).toMatchObject({
			success: false,
			values: {
				error: "MEDIA_GENERATION_MISSING_URL",
				mediaType: "video",
				prompt: "glass lighthouse",
			},
		});
	});
});
