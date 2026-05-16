/**
 * Soft cloud fallback wrapper for local IMAGE_DESCRIPTION handlers.
 *
 * The local vision path can report recoverable unavailability (missing
 * projector, inactive bundle, backend pressure) without forcing callers to
 * know which cloud provider is paired. The wrapper keeps that state explicit:
 * handlers either return a normal image description or a typed fallback
 * outcome that the next layer can handle.
 */

import type {
	ImageDescriptionParams,
	ImageDescriptionResult,
} from "@elizaos/core";

export type VisionFallbackReason =
	| "local-unavailable"
	| "local-overloaded"
	| "local-error"
	| "local-aborted-pre-completion"
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

export type LocalImageDescriptionHandler = (
	params: ImageDescriptionParams | string,
) => Promise<LocalVisionOutcome>;

export type WrappedImageDescriptionHandler = LocalImageDescriptionHandler;

export interface VisionCloudFallbackOptions {
	handler?: (
		params: ImageDescriptionParams | string,
		reason: VisionFallbackReason,
	) => Promise<ImageDescriptionResult | string>;
	token?: string;
	baseUrl?: string;
	fetch?: typeof fetch;
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
	return (
		typeof outcome === "object" &&
		outcome !== null &&
		"kind" in outcome &&
		outcome.kind === "fallback"
	);
}

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
			const handler =
				options.handler ??
				(options.token
					? async (fallbackParams: ImageDescriptionParams | string) =>
							describeWithHttpFallback(fallbackParams, {
								token: options.token as string,
								baseUrl: options.baseUrl ?? "https://www.elizacloud.ai/api",
								fetchImpl: options.fetch ?? fetch,
							})
					: null);
			if (!handler) return localOutcome;

			try {
				return normalizeVisionDescription(
					await handler(params, localOutcome.reason),
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

async function describeWithHttpFallback(
	params: ImageDescriptionParams | string,
	options: { token: string; baseUrl: string; fetchImpl: typeof fetch },
): Promise<ImageDescriptionResult> {
	const body =
		typeof params === "string"
			? { image: { kind: "url", url: params } }
			: {
					image: { kind: "url", url: params.imageUrl },
					...(params.prompt ? { prompt: params.prompt } : {}),
				};
	const response = await options.fetchImpl(
		`${options.baseUrl.replace(/\/+$/, "")}/v1/vision/describe`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${options.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		},
	);
	if (!response.ok) {
		throw new Error(`vision fallback failed with ${response.status}`);
	}
	return (await response.json()) as ImageDescriptionResult;
}
