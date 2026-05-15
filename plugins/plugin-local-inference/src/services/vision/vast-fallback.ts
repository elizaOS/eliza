import type {
	LocalImageDescriptionHandler,
	LocalVisionOutcome,
} from "./cloud-fallback";

export interface VisionVastFallbackOptions {
	enabled?: boolean;
	handler?: LocalImageDescriptionHandler;
	log?: (message: string, detail?: Record<string, unknown>) => void;
}

function isFallbackOutcome(
	outcome: LocalVisionOutcome,
): outcome is Extract<LocalVisionOutcome, { kind: "fallback" }> {
	return (
		typeof outcome === "object" &&
		outcome !== null &&
		"kind" in outcome &&
		outcome.kind === "fallback"
	);
}

export function wrapImageDescriptionHandlerWithVastFallback(
	upstream: LocalImageDescriptionHandler,
	options: VisionVastFallbackOptions = {},
): LocalImageDescriptionHandler {
	const enabled = options.enabled ?? true;
	const log = options.log ?? (() => undefined);
	return async (params) => {
		const upstreamOutcome = await upstream(params);
		if (!isFallbackOutcome(upstreamOutcome)) return upstreamOutcome;
		if (!enabled || !options.handler) return upstreamOutcome;

		log("[vision/vast-fallback] upstream IMAGE_DESCRIPTION fallback", {
			reason: upstreamOutcome.reason,
		});
		try {
			return await options.handler(params);
		} catch (error) {
			return {
				kind: "fallback",
				reason: "vast-error",
				cause: error instanceof Error ? error : new Error(String(error)),
			};
		}
	};
}
