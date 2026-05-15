/**
 * Final optional IMAGE_DESCRIPTION fallback layer.
 *
 * This mirrors the cloud wrapper shape but only runs when the previous
 * handler explicitly returned a typed fallback outcome.
 */

import type {
	ImageDescriptionParams,
	ImageDescriptionResult,
} from "@elizaos/core";
import {
	isVisionFallbackOutcome,
	type LocalVisionOutcome,
	normalizeVisionDescription,
	type VisionFallbackReason,
	type WrappedImageDescriptionHandler,
} from "./cloud-fallback";

export interface VisionVastFallbackOptions {
	handler?: (
		params: ImageDescriptionParams | string,
		reason: VisionFallbackReason,
	) => Promise<ImageDescriptionResult | string>;
	log?: (message: string, detail?: Record<string, unknown>) => void;
}

export function wrapImageDescriptionHandlerWithVastFallback(
	previous: WrappedImageDescriptionHandler,
	options: VisionVastFallbackOptions = {},
): WrappedImageDescriptionHandler {
	const log = options.log ?? (() => undefined);
	return async (params): Promise<LocalVisionOutcome> => {
		const outcome = await previous(params);
		if (!isVisionFallbackOutcome(outcome)) {
			return normalizeVisionDescription(outcome);
		}

		log("[vision/vast-fallback] previous handler requested fallback", {
			reason: outcome.reason,
		});
		if (!options.handler) return outcome;

		try {
			return normalizeVisionDescription(
				await options.handler(params, outcome.reason),
			);
		} catch (err) {
			return {
				kind: "fallback",
				reason: "local-error",
				cause: err instanceof Error ? err : undefined,
			};
		}
	};
}
