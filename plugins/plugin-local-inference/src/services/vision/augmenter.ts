/**
 * Vision-context augmentation seam (issue #9105).
 *
 * The on-device VL model (Gemma-4 vision) describes raw image pixels. This
 * seam lets a higher-level plugin (plugin-vision) run lightweight, token-free
 * pre-vision detectors over the same image — OCR (tesseract), object detection
 * (YOLO), face detection — and fold their results into the describe prompt as
 * structured text context. The VL model then grounds its description in real
 * extracted signals instead of guessing at small text or object identity.
 *
 * Layering: the IMAGE_DESCRIPTION handler (this package) is the consumer, while
 * plugin-vision contributes a runtime-scoped service under the core
 * `VISION_CONTEXT_AUGMENTER` service type. Keeping the seam in the runtime
 * avoids process-global state and preserves identity across separately bundled
 * plugin entrypoints.
 */

import { type IAgentRuntime, type Service, ServiceType } from "@elizaos/core";
import type { VisionImageInput } from "./types";

/**
 * Raw pre-vision signals extracted from an image. Every field is optional —
 * a detector that is unavailable (no model artifact, wrong platform) simply
 * contributes nothing rather than failing the describe.
 */
export interface VisionFusedContext {
	/** OCR text blocks, newest-distilled into one prompt-ready string. */
	ocrText?: string;
	/** Detected objects as a prompt-ready string (e.g. `person (0.94), laptop (0.81)`). */
	objects?: string;
	/** Face summary (e.g. `2 faces`). */
	faces?: string;
}

/** Result of augmenting a describe prompt with fused pre-vision context. */
export interface VisionAugmentResult {
	/** The base prompt with the fused-context block appended. */
	prompt: string;
	/** The raw signals that produced the block (for telemetry / enrichment). */
	fused: VisionFusedContext;
}

/**
 * A provider that runs pre-vision detectors over an image and returns an
 * augmented describe prompt. Returns `null` when nothing useful was detected
 * (so the handler keeps the original prompt unchanged).
 */
export interface VisionContextAugmenter {
	/** Stable identifier, surfaced in logs. */
	readonly name: string;
	augmentImagePrompt(input: {
		image: VisionImageInput;
		basePrompt?: string;
	}): Promise<VisionAugmentResult | null>;
}

type VisionContextAugmenterRuntimeService = Service & VisionContextAugmenter;

/**
 * Fold pre-vision detector signals into a describe request's prompt, in place,
 * when an augmenter is registered. Best-effort: a missing or failing augmenter
 * leaves the request unchanged so the VL model still describes the raw image —
 * the augmentation is extra grounding context, never a hard dependency of
 * IMAGE_DESCRIPTION. Used by the IMAGE_DESCRIPTION handler in `provider.ts`.
 */
export async function augmentVisionRequest(
	runtime: IAgentRuntime,
	request: {
		image: VisionImageInput;
		prompt?: string;
	},
): Promise<void> {
	const augmenter = runtime.getService<VisionContextAugmenterRuntimeService>(
		ServiceType.VISION_CONTEXT_AUGMENTER,
	);
	if (!augmenter) return;
	try {
		const augmented = await augmenter.augmentImagePrompt({
			image: request.image,
			basePrompt: request.prompt,
		});
		if (augmented?.prompt) {
			request.prompt = augmented.prompt;
		}
	} catch (error) {
		// error-policy:J7 Optional grounding may degrade, but the failure remains observable.
		runtime.reportError("LocalInference.VisionContextAugmenter", error, {
			augmenter: augmenter.name,
		});
	}
}
