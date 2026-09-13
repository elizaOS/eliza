/** Covers the vision context-augmenter registry and `augmentVisionRequest`. Deterministic. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	augmentVisionRequest,
	getVisionContextAugmenter,
	registerVisionContextAugmenter,
	type VisionContextAugmenter,
} from "./augmenter";

afterEach(() => registerVisionContextAugmenter(null));

const IMAGE = {
	kind: "dataUrl" as const,
	dataUrl: "data:image/png;base64,AAAA",
};

describe("vision context augmenter registry", () => {
	it("registers and clears", () => {
		const a: VisionContextAugmenter = {
			name: "x",
			async augmentImagePrompt() {
				return null;
			},
		};
		registerVisionContextAugmenter(a);
		expect(getVisionContextAugmenter()).toBe(a);
		registerVisionContextAugmenter(null);
		expect(getVisionContextAugmenter()).toBeNull();
	});
});

describe("augmentVisionRequest", () => {
	it("rewrites the prompt with the augmenter output", async () => {
		registerVisionContextAugmenter({
			name: "fused",
			async augmentImagePrompt({ basePrompt }) {
				return {
					prompt: `${basePrompt ?? "Describe."}\n\nDetected context\n- Text (OCR): "HELLO 42"`,
					fused: { ocrText: '"HELLO 42"' },
				};
			},
		});
		const request = { image: IMAGE, prompt: "Describe this." };
		await augmentVisionRequest(request);
		expect(request.prompt).toContain("Describe this.");
		expect(request.prompt).toContain('Text (OCR): "HELLO 42"');
	});

	it("is a no-op when no augmenter is registered", async () => {
		const request = { image: IMAGE, prompt: "unchanged" };
		await augmentVisionRequest(request);
		expect(request.prompt).toBe("unchanged");
	});

	it("leaves the prompt unchanged when the augmenter returns null", async () => {
		registerVisionContextAugmenter({
			name: "empty",
			async augmentImagePrompt() {
				return null;
			},
		});
		const request = { image: IMAGE, prompt: "keep me" };
		await augmentVisionRequest(request);
		expect(request.prompt).toBe("keep me");
	});

	it("swallows augmenter failures and keeps the original prompt (best-effort)", async () => {
		registerVisionContextAugmenter({
			name: "boom",
			async augmentImagePrompt() {
				throw new Error("detector crashed");
			},
		});
		const request = { image: IMAGE, prompt: "survive" };
		await expect(augmentVisionRequest(request)).resolves.toBeUndefined();
		expect(request.prompt).toBe("survive");
	});
});

/**
 * The package ships this module in both `dist/index.js` (the IMAGE_DESCRIPTION
 * reader) and the `services` subpath (where plugin-vision registers). A
 * registration through one module instance must be visible to a second,
 * independently evaluated instance; `vi.resetModules()` produces that instance.
 */
describe("registry is shared across module instances", () => {
	it("augments through an instance other than the one that registered", async () => {
		const first = await import("./augmenter");
		const augmenter: VisionContextAugmenter = {
			name: "cross-bundle",
			async augmentImagePrompt({ basePrompt }) {
				return { prompt: `${basePrompt ?? ""} [ocr: hello]`, fused: {} };
			},
		};
		first.registerVisionContextAugmenter(augmenter);

		vi.resetModules();
		const second = await import("./augmenter");
		expect(second).not.toBe(first);
		expect(second.getVisionContextAugmenter()).toBe(augmenter);
		const request = { image: IMAGE, prompt: "Describe" };
		await second.augmentVisionRequest(request);
		expect(request.prompt).toBe("Describe [ocr: hello]");

		second.registerVisionContextAugmenter(null);
		expect(first.getVisionContextAugmenter()).toBeNull();
	});
});
