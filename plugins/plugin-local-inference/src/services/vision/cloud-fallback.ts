import type {
	ImageDescriptionParams,
	ImageDescriptionResult,
} from "@elizaos/core";

export type VisionFallbackReason =
	| "local-unavailable"
	| "local-overloaded"
	| "local-error"
	| "local-aborted-pre-completion"
	| "cloud-unavailable"
	| "cloud-error"
	| "vast-unavailable"
	| "vast-error";

export type LocalVisionOutcome =
	| ImageDescriptionResult
	| { kind: "fallback"; reason: VisionFallbackReason; cause?: Error };

export type LocalImageDescriptionHandler = (
	params: ImageDescriptionParams | string,
) => Promise<LocalVisionOutcome>;

export type WrappedImageDescriptionHandler = LocalImageDescriptionHandler;

export interface VisionCloudFallbackOptions {
	enabled?: boolean;
	handler?: LocalImageDescriptionHandler;
	log?: (message: string, detail?: Record<string, unknown>) => void;
}

export function classifyLocalVisionError(error: unknown): {
	fallback: boolean;
	reason: VisionFallbackReason;
	cause?: Error;
} {
	const cause = error instanceof Error ? error : new Error(String(error));
	const message = cause.message.toLowerCase();
	if (cause.name === "AbortError") {
		return {
			fallback: false,
			reason: "local-aborted-pre-completion",
			cause,
		};
	}
	if (
		message.includes("requires an active") ||
		message.includes("capability_unavailable") ||
		message.includes("backend_unavailable") ||
		message.includes("no mtmd binding") ||
		message.includes("not implemented") ||
		message.includes("not available")
	) {
		return { fallback: true, reason: "local-unavailable", cause };
	}
	if (
		message.includes("thermal") ||
		message.includes("busy") ||
		message.includes("overloaded") ||
		message.includes("timeout")
	) {
		return { fallback: true, reason: "local-overloaded", cause };
	}
	return { fallback: true, reason: "local-error", cause };
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

export function wrapImageDescriptionHandlerWithCloudFallback(
	local: LocalImageDescriptionHandler,
	options: VisionCloudFallbackOptions = {},
): WrappedImageDescriptionHandler {
	const enabled = options.enabled ?? true;
	const log = options.log ?? (() => undefined);
	return async (params) => {
		let localOutcome: LocalVisionOutcome;
		try {
			localOutcome = await local(params);
		} catch (error) {
			const classified = classifyLocalVisionError(error);
			if (!classified.fallback) throw error;
			localOutcome = {
				kind: "fallback",
				reason: classified.reason,
				cause: classified.cause,
			};
		}
		if (!isFallbackOutcome(localOutcome)) return localOutcome;
		if (!enabled || !options.handler) return localOutcome;

		log("[vision/cloud-fallback] local IMAGE_DESCRIPTION fallback", {
			reason: localOutcome.reason,
		});
		try {
			const cloudOutcome = await options.handler(params);
			return cloudOutcome;
		} catch (error) {
			return {
				kind: "fallback",
				reason: "cloud-error",
				cause: error instanceof Error ? error : new Error(String(error)),
			};
		}
	};
}
