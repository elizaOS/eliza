/** Covers runtime-scoped vision context augmentation and its no-provider behavior. Deterministic. */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { augmentVisionRequest, type VisionContextAugmenter } from "./augmenter";

const IMAGE = {
	kind: "dataUrl" as const,
	dataUrl: "data:image/png;base64,AAAA",
};

function runtimeWith(
	augmenter: VisionContextAugmenter | null,
	onReport?: (scope: string, error: unknown) => void,
): IAgentRuntime {
	return {
		getService: () => augmenter,
		reportError: (scope: string, error: unknown) => onReport?.(scope, error),
	} as unknown as IAgentRuntime;
}

describe("augmentVisionRequest", () => {
	it("rewrites the prompt with the augmenter output", async () => {
		const runtime = runtimeWith({
			name: "fused",
			async augmentImagePrompt({ basePrompt }) {
				return {
					prompt: `${basePrompt ?? "Describe."}\n\nDetected context\n- Text (OCR): "HELLO 42"`,
					fused: { ocrText: '"HELLO 42"' },
				};
			},
		});
		const request = { image: IMAGE, prompt: "Describe this." };
		await augmentVisionRequest(runtime, request);
		expect(request.prompt).toContain("Describe this.");
		expect(request.prompt).toContain('Text (OCR): "HELLO 42"');
	});

	it("is a no-op when no augmenter service is registered", async () => {
		const request = { image: IMAGE, prompt: "unchanged" };
		await augmentVisionRequest(runtimeWith(null), request);
		expect(request.prompt).toBe("unchanged");
	});

	it("leaves the prompt unchanged when the augmenter returns null", async () => {
		const runtime = runtimeWith({
			name: "empty",
			async augmentImagePrompt() {
				return null;
			},
		});
		const request = { image: IMAGE, prompt: "keep me" };
		await augmentVisionRequest(runtime, request);
		expect(request.prompt).toBe("keep me");
	});

	it("reports augmenter failures while keeping the original prompt", async () => {
		const reported: Array<{ scope: string; error: unknown }> = [];
		const runtime = runtimeWith(
			{
				name: "boom",
				async augmentImagePrompt() {
					throw new Error("detector crashed");
				},
			},
			(scope, error) => reported.push({ scope, error }),
		);
		const request = { image: IMAGE, prompt: "survive" };
		await expect(
			augmentVisionRequest(runtime, request),
		).resolves.toBeUndefined();
		expect(request.prompt).toBe("survive");
		expect(reported).toEqual([
			{
				scope: "LocalInference.VisionContextAugmenter",
				error: expect.objectContaining({ message: "detector crashed" }),
			},
		]);
	});
});
