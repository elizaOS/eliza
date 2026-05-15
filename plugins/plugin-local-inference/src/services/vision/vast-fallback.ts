import type {
	ImageDescriptionParams,
	ImageDescriptionResult,
} from "@elizaos/core";
import type {
	LocalImageDescriptionHandler,
	VisionFallbackReason,
} from "./cloud-fallback";

export interface VisionVastFallbackOptions {
	handler?: (
		params: ImageDescriptionParams | string,
		reason: VisionFallbackReason,
		cause?: Error,
	) => Promise<ImageDescriptionResult | string>;
	log?: (message: string, detail?: Record<string, unknown>) => void;
}

export function wrapImageDescriptionHandlerWithVastFallback(
	upstream: LocalImageDescriptionHandler,
	options: VisionVastFallbackOptions = {},
): LocalImageDescriptionHandler {
	const log = options.log ?? (() => undefined);
	return async (params) => {
		const outcome = await upstream(params);
		if (
			!outcome ||
			typeof outcome !== "object" ||
			!("kind" in outcome) ||
			outcome.kind !== "fallback"
		) {
			return outcome;
		}

		if (!options.handler) return outcome;
		log("[vision/vast-fallback] forwarding IMAGE_DESCRIPTION request", {
			reason: outcome.reason,
		});
		try {
			return await options.handler(params, outcome.reason, outcome.cause);
		} catch (err) {
			return {
				kind: "fallback",
				reason: "cloud-error",
				cause: err instanceof Error ? err : new Error(String(err)),
			};
		}
	};
}
