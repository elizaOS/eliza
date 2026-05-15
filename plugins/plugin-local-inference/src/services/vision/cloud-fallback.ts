import type {
	ImageDescriptionParams,
	ImageDescriptionResult,
} from "@elizaos/core";

export type VisionFallbackReason =
	| "local-unavailable"
	| "local-overloaded"
	| "local-error"
	| "local-aborted-pre-completion"
	| "local-not-registered"
	| "cloud-unavailable"
	| "cloud-error";

export type LocalVisionOutcome =
	| ImageDescriptionResult
	| string
	| {
			kind: "fallback";
			reason: VisionFallbackReason;
			cause?: Error;
	  };

export type LocalImageDescriptionHandler = (
	params: ImageDescriptionParams | string,
) => Promise<LocalVisionOutcome>;

export type WrappedImageDescriptionHandler = LocalImageDescriptionHandler;

export interface VisionCloudFallbackOptions {
	handler?: (
		params: ImageDescriptionParams | string,
		reason: VisionFallbackReason,
		cause?: Error,
	) => Promise<ImageDescriptionResult | string>;
	log?: (message: string, detail?: Record<string, unknown>) => void;
}

export function classifyLocalVisionError(err: unknown): {
	fallback: boolean;
	reason: VisionFallbackReason;
} {
	if (err instanceof Error) {
		if (err.name === "AbortError") {
			return { fallback: false, reason: "local-aborted-pre-completion" };
		}
		const msg = err.message.toLowerCase();
		if (
			msg.includes("vision-capable bundle") ||
			msg.includes("vision-describe capability") ||
			msg.includes("not installed in this build") ||
			msg.includes("node-llama-cpp is not installed") ||
			msg.includes("no mtmd binding") ||
			msg.includes("no local model is active") ||
			msg.includes("dlopen") ||
			msg.includes("missing libllama")
		) {
			return { fallback: true, reason: "local-unavailable" };
		}
		if (
			msg.includes("decode: failed to find a memory slot") ||
			msg.includes("thermal") ||
			msg.includes("low-power") ||
			msg.includes("overloaded")
		) {
			return { fallback: true, reason: "local-overloaded" };
		}
		if (
			msg.includes("llama_decode") ||
			msg.includes("llama_tokenize") ||
			msg.includes("llama_sampler") ||
			msg.includes("ggml_assert")
		) {
			return { fallback: true, reason: "local-error" };
		}
	}
	return { fallback: false, reason: "local-error" };
}

export function wrapImageDescriptionHandlerWithCloudFallback(
	local: LocalImageDescriptionHandler,
	options: VisionCloudFallbackOptions = {},
): WrappedImageDescriptionHandler {
	const log = options.log ?? (() => undefined);
	return async (params) => {
		let localOutcome: LocalVisionOutcome;
		try {
			localOutcome = await local(params);
		} catch (err) {
			const classified = classifyLocalVisionError(err);
			if (!classified.fallback) throw err;
			localOutcome = {
				kind: "fallback",
				reason: classified.reason,
				cause: err instanceof Error ? err : new Error(String(err)),
			};
		}

		if (
			!localOutcome ||
			typeof localOutcome !== "object" ||
			!("kind" in localOutcome) ||
			localOutcome.kind !== "fallback"
		) {
			return localOutcome;
		}

		if (!options.handler) return localOutcome;
		log("[vision/cloud-fallback] forwarding IMAGE_DESCRIPTION request", {
			reason: localOutcome.reason,
		});
		try {
			return await options.handler(
				params,
				localOutcome.reason,
				localOutcome.cause,
			);
		} catch (err) {
			return {
				kind: "fallback",
				reason: "cloud-error",
				cause: err instanceof Error ? err : new Error(String(err)),
			};
		}
	};
}
