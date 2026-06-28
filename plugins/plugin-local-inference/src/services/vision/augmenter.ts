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
 * Layering: the IMAGE_DESCRIPTION handler (this package) is the *consumer*; it
 * owns the registry and reads whatever augmenter is registered. plugin-vision
 * is the *provider*; it registers its implementation at boot via a best-effort
 * dynamic import (no hard dependency in either direction — mirrors the
 * coord-OCR bridge plugin-vision already uses for plugin-computeruse). When no
 * augmenter is registered the handler describes the image unaugmented.
 */

import { logger } from "@elizaos/core";
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

let registered: VisionContextAugmenter | null = null;

/**
 * Register (or clear, with `null`) the process-wide vision-context augmenter.
 * Last writer wins — a native provider can override an earlier registration.
 */
export function registerVisionContextAugmenter(
	augmenter: VisionContextAugmenter | null,
): void {
	registered = augmenter;
}

/** The currently registered augmenter, or `null` when none is wired. */
export function getVisionContextAugmenter(): VisionContextAugmenter | null {
	return registered;
}

/**
 * Fold pre-vision detector signals into a describe request's prompt, in place,
 * when an augmenter is registered. Best-effort: a missing or failing augmenter
 * leaves the request unchanged so the VL model still describes the raw image —
 * the augmentation is extra grounding context, never a hard dependency of
 * IMAGE_DESCRIPTION. Used by the IMAGE_DESCRIPTION handler in `provider.ts`.
 */
export async function augmentVisionRequest(request: {
	image: VisionImageInput;
	prompt?: string;
}): Promise<void> {
	const augmenter = registered;
	if (!augmenter) return;
	try {
		const augmented = await augmenter.augmentImagePrompt({
			image: request.image,
			basePrompt: request.prompt,
		});
		if (augmented?.prompt) {
			request.prompt = augmented.prompt;
		}
	} catch (err) {
		logger.warn(
			`[local-inference] vision context augmenter '${augmenter.name}' failed; describing unaugmented: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}
