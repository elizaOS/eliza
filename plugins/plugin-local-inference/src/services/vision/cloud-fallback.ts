/**
 * Soft cloud fallback wrapper for local IMAGE_DESCRIPTION handlers.
 *
 * The local vision path can report recoverable unavailability without forcing
 * callers to know which remote provider is paired. The wrapper keeps that
 * state explicit: handlers return a normal image description or a typed
 * fallback outcome that the next layer can handle.
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
	| "local-not-registered"
	| "cloud-unavailable"
	| "cloud-error"
	| "vast-unavailable"
	| "vast-error";

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
	enabled?: boolean;
	token?: string;
	apiKey?: string;
	baseUrl?: string;
	fetch?: typeof fetch;
	handler?: (
		params: ImageDescriptionParams | string,
		reason: VisionFallbackReason,
	) => Promise<LocalVisionOutcome>;
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
		message.includes("no local") ||
		message.includes("not registered") ||
		message.includes("not installed") ||
		message.includes("requires an active") ||
		message.includes("capability_unavailable") ||
		message.includes("backend_unavailable") ||
		message.includes("no mtmd binding") ||
		message.includes("not implemented") ||
		message.includes("not available") ||
		message.includes("missing") ||
		message.includes("dlopen")
	) {
		return { fallback: true, reason: "local-unavailable", cause };
	}
	if (
		message.includes("busy") ||
		message.includes("overloaded") ||
		message.includes("thermal") ||
		message.includes("low-power") ||
		message.includes("timeout")
	) {
		return { fallback: true, reason: "local-overloaded", cause };
	}
	if (
		message.includes("llama_decode") ||
		message.includes("mtmd") ||
		message.includes("projector") ||
		message.includes("ggml_assert")
	) {
		return { fallback: true, reason: "local-error", cause };
	}
	return { fallback: true, reason: "local-error", cause };
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
		const title = result.title.trim();
		const description = result.description.trim();
		if (title === result.title && description === result.description) {
			return result;
		}
		return { title, description };
	}
	throw new Error(
		"[vision-fallback] IMAGE_DESCRIPTION backend returned an invalid description",
	);
}

function resolveCloudToken(options: VisionCloudFallbackOptions): string | null {
	return (
		options.token?.trim() ||
		options.apiKey?.trim() ||
		process.env.ELIZA_CLOUD_TOKEN?.trim() ||
		process.env.ELIZA_CLOUD_API_KEY?.trim() ||
		null
	);
}

function resolveCloudBaseUrl(options: VisionCloudFallbackOptions): string {
	return (
		options.baseUrl?.trim() ||
		process.env.ELIZA_CLOUD_BASE_URL?.trim() ||
		"https://api.elizacloud.ai"
	).replace(/\/+$/, "");
}

function imageRequestBody(params: ImageDescriptionParams | string): {
	image: { kind: "url"; url: string } | { kind: "data"; data: string };
	prompt?: string;
} {
	if (typeof params === "string") {
		return params.startsWith("data:")
			? { image: { kind: "data", data: params } }
			: { image: { kind: "url", url: params } };
	}
	const imageUrl = (params as { imageUrl?: string }).imageUrl;
	const image = (params as { image?: string }).image;
	const source = imageUrl ?? image;
	const body = source?.startsWith("data:")
		? { image: { kind: "data" as const, data: source } }
		: { image: { kind: "url" as const, url: source ?? "" } };
	if (params.prompt) return { ...body, prompt: params.prompt };
	return body;
}

async function callCloudVision(
	params: ImageDescriptionParams | string,
	options: VisionCloudFallbackOptions,
): Promise<ImageDescriptionResult> {
	const token = resolveCloudToken(options);
	if (!token) {
		throw new Error("Eliza Cloud image fallback is not configured");
	}
	const fetchImpl = options.fetch ?? fetch;
	const response = await fetchImpl(
		`${resolveCloudBaseUrl(options)}/v1/vision/describe`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(imageRequestBody(params)),
		},
	);
	if (!response.ok) {
		throw new Error(`Eliza Cloud image fallback failed with ${response.status}`);
	}
	return normalizeVisionDescription((await response.json()) as LocalVisionResult);
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

		if (!isVisionFallbackOutcome(localOutcome)) {
			return normalizeVisionDescription(localOutcome);
		}
		if (!enabled) return localOutcome;

		const token = resolveCloudToken(options);
		if (!options.handler && !token) return localOutcome;

		log("[vision/cloud-fallback] local IMAGE_DESCRIPTION fallback", {
			reason: localOutcome.reason,
		});
		try {
			const cloudOutcome = options.handler
				? await options.handler(params, localOutcome.reason)
				: await callCloudVision(params, options);
			if (isVisionFallbackOutcome(cloudOutcome)) return cloudOutcome;
			return normalizeVisionDescription(cloudOutcome);
		} catch (error) {
			return {
				...localOutcome,
				cause: error instanceof Error ? error : new Error(String(error)),
			};
		}
	};
}
