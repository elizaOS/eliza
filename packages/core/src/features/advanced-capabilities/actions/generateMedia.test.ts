/**
 * Covers the GENERATE_MEDIA action's validate/handler: provider gating (media
 * service vs IMAGE-model fallback), missing-URL failure, attachment delivery,
 * and i18n-safe media-kind routing (#10471). Runs against a deterministic mock
 * runtime (vi.fn media service, no live model).
 */

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

	it("marks generated media attachments for connector delivery", async () => {
		const callback = vi.fn();
		const generateMedia = vi.fn(async () => ({
			mediaType: "video",
			videoUrl: "https://cdn.example.com/generated/clip.mp4",
			mimeType: "video/mp4",
		}));
		const result = await generateMediaAction.handler?.(
			runtimeWithMediaService(true, generateMedia),
			message,
			undefined,
			{
				parameters: { mediaType: "video", prompt: "glass lighthouse" },
			},
			callback,
		);

		expect(result).toMatchObject({
			success: true,
			values: {
				mediaGenerated: true,
				mediaType: "video",
			},
		});
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({
				source: "media-generation",
				attachments: [
					expect.objectContaining({
						url: "https://cdn.example.com/generated/clip.mp4",
						source: "media-generation",
						contentType: "video",
					}),
				],
			}),
		);
	});
});

describe("generateMediaAction media-kind routing is i18n-safe (#10471)", () => {
	it("honors the structured mediaType enum regardless of message language", async () => {
		const generateMedia = vi.fn(async () => ({
			mediaType: "video",
			videoUrl: "https://cdn.example.com/v.mp4",
			mimeType: "video/mp4",
		}));
		// Non-English prompt; routing must come from params.mediaType, not text.
		const jaMessage = {
			id: "msg",
			roomId: "room",
			content: { text: "猫の動画を作って" },
		} as never;
		await generateMediaAction.handler?.(
			runtimeWithMediaService(true, generateMedia),
			jaMessage,
			undefined,
			{ parameters: { mediaType: "video", prompt: "a cat" } },
		);
		expect(generateMedia).toHaveBeenCalledWith(
			expect.objectContaining({ mediaType: "video" }),
		);
	});

	it("does NOT infer media kind from English text when mediaType is absent", async () => {
		const generateMedia = vi.fn(async () => ({
			mediaType: "image",
			url: "https://cdn.example.com/i.png",
			mimeType: "image/png",
		}));
		// English "video"/"music" words in the prompt must not steer the media
		// kind — only the structured enum does. Absent enum ⇒ image.
		const englishyMessage = {
			id: "msg",
			roomId: "room",
			content: { text: "make a video with background music of a lighthouse" },
		} as never;
		await generateMediaAction.handler?.(
			runtimeWithMediaService(true, generateMedia),
			englishyMessage,
			undefined,
			{ parameters: { prompt: "a lighthouse" } },
		);
		expect(generateMedia).toHaveBeenCalledWith(
			expect.objectContaining({ mediaType: "image" }),
		);
	});
});
