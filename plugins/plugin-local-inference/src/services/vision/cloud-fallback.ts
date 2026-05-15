<<<<<<< HEAD
/**
 * Soft cloud fallback wrapper for local IMAGE_DESCRIPTION handlers.
 *
 * The local vision path can report recoverable unavailability (missing
 * projector, inactive bundle, backend pressure) without forcing callers to
 * know which cloud provider is paired. The wrapper keeps that state explicit:
 * handlers either return a normal image description or a typed fallback
 * outcome that the next layer can handle.
 */

=======
>>>>>>> origin/codex/fused-local-inference-latest-20260515
import type {
	ImageDescriptionParams,
	ImageDescriptionResult,
} from "@elizaos/core";

export type VisionFallbackReason =
	| "local-unavailable"
	| "local-overloaded"
	| "local-error"
	| "local-aborted-pre-completion"
<<<<<<< HEAD
	| "local-not-registered";

export type LocalVisionOutcome =
	| ImageDescriptionResult
	| string
	| { kind: "ok"; result: ImageDescriptionResult | string }
	| { kind: "fallback"; reason: VisionFallbackReason; cause?: Error };

export type LocalVisionResult = Exclude<
	LocalVisionOutcome,
	{ kind: "fallback"; reason: VisionFallbackReason; cause?: Error }
>;

=======
	| "cloud-unavailable"
	| "cloud-error"
	| "vast-unavailable"
	| "vast-error";

export type LocalVisionOutcome =
	| ImageDescriptionResult
	| { kind: "fallback"; reason: VisionFallbackReason; cause?: Error };

>>>>>>> origin/codex/fused-local-inference-latest-20260515
export type LocalImageDescriptionHandler = (
	params: ImageDescriptionParams | string,
) => Promise<LocalVisionOutcome>;

export type WrappedImageDescriptionHandler = LocalImageDescriptionHandler;

export interface VisionCloudFallbackOptions {
<<<<<<< HEAD
	handler?: (
		params: ImageDescriptionParams | string,
		reason: VisionFallbackReason,
	) => Promise<ImageDescriptionResult | string>;
	log?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface LocalVisionErrorClassification {
	fallback: boolean;
	reason: VisionFallbackReason;
}

export function classifyLocalVisionError(
	err: unknown,
): LocalVisionErrorClassification {
	if (err instanceof Error) {
		if (err.name === "AbortError") {
			return { fallback: false, reason: "local-aborted-pre-completion" };
		}
		const msg = err.message.toLowerCase();
		if (
			msg.includes("no local") ||
			msg.includes("not registered") ||
			msg.includes("not installed") ||
			msg.includes("requires an active") ||
			msg.includes("missing") ||
			msg.includes("dlopen")
		) {
			return { fallback: true, reason: "local-unavailable" };
		}
		if (
			msg.includes("busy") ||
			msg.includes("overloaded") ||
			msg.includes("thermal") ||
			msg.includes("low-power")
		) {
			return { fallback: true, reason: "local-overloaded" };
		}
		if (
			msg.includes("llama_decode") ||
			msg.includes("mtmd") ||
			msg.includes("projector") ||
			msg.includes("ggml_assert")
		) {
			return { fallback: true, reason: "local-error" };
		}
	}
	return { fallback: false, reason: "local-error" };
}

export function isVisionFallbackOutcome(
	outcome: LocalVisionOutcome,
): outcome is {
	kind: "fallback";
	reason: VisionFallbackReason;
	cause?: Error;
} {
=======
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
>>>>>>> origin/codex/fused-local-inference-latest-20260515
	return (
		typeof outcome === "object" &&
		outcome !== null &&
		"kind" in outcome &&
		outcome.kind === "fallback"
	);
}

<<<<<<< HEAD
export function normalizeVisionDescription(
	result: LocalVisionResult,
): ImageDescriptionResult {
	if (typeof result === "object" && result !== null && "kind" in result) {
		return normalizeVisionDescription(result.result);
	}
	if (typeof result === "string") {
		const description = result.trim();
		if (!description) {
			throw new Error(
				"[vision-fallback] IMAGE_DESCRIPTION backend returned an empty description",
			);
		}
		return {
			title: description.split(/[.!?]/, 1)[0]?.trim() || "Image",
			description,
		};
	}
	if (
		result &&
		typeof result.title === "string" &&
		typeof result.description === "string" &&
		result.title.trim() &&
		result.description.trim()
	) {
		return {
			title: result.title.trim(),
			description: result.description.trim(),
		};
	}
	throw new Error(
		"[vision-fallback] IMAGE_DESCRIPTION backend returned an invalid description",
	);
}

=======
>>>>>>> origin/codex/fused-local-inference-latest-20260515
export function wrapImageDescriptionHandlerWithCloudFallback(
	local: LocalImageDescriptionHandler,
	options: VisionCloudFallbackOptions = {},
): WrappedImageDescriptionHandler {
<<<<<<< HEAD
=======
	const enabled = options.enabled ?? true;
>>>>>>> origin/codex/fused-local-inference-latest-20260515
	const log = options.log ?? (() => undefined);
	return async (params) => {
		let localOutcome: LocalVisionOutcome;
		try {
			localOutcome = await local(params);
<<<<<<< HEAD
		} catch (err) {
			const classification = classifyLocalVisionError(err);
			if (!classification.fallback) throw err;
			localOutcome = {
				kind: "fallback",
				reason: classification.reason,
				cause: err instanceof Error ? err : undefined,
			};
		}

		if (!isVisionFallbackOutcome(localOutcome)) {
			return normalizeVisionDescription(localOutcome);
		}

		log("[vision/cloud-fallback] local handler requested fallback", {
			reason: localOutcome.reason,
		});
		if (!options.handler) return localOutcome;

		try {
			return normalizeVisionDescription(
				await options.handler(params, localOutcome.reason),
			);
		} catch (err) {
			return {
				kind: "fallback",
				reason: "local-error",
				cause: err instanceof Error ? err : undefined,
=======
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
>>>>>>> origin/codex/fused-local-inference-latest-20260515
			};
		}
	};
}
