import type {
	LocalImageDescriptionHandler,
	LocalVisionOutcome,
	VisionFallbackReason,
} from "./cloud-fallback";
export interface VisionVastFallbackOptions {
	handler?: LocalImageDescriptionHandler;
	log?: (message: string, detail?: Record<string, unknown>) => void;
}
function asError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}
function isFallback(outcome: LocalVisionOutcome): outcome is {
	kind: "fallback";
	reason: VisionFallbackReason;
	cause?: Error;
} {
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
	const log = options.log ?? (() => undefined);
	return async (params) => {
		const outcome = await upstream(params);
		if (!isFallback(outcome)) return outcome;
		if (!options.handler) return outcome;
		log("[vision/vast-fallback] forwarding IMAGE_DESCRIPTION", {
			reason: outcome.reason,
		});
		try {
			return await options.handler(params);
		} catch (err) {
			return { kind: "fallback", reason: "cloud-error", cause: asError(err) };
		}
	};
}
