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
	type LocalVisionResult,
	normalizeVisionDescription,
	type VisionFallbackReason,
	type WrappedImageDescriptionHandler,
} from "./cloud-fallback";

export interface VisionVastFallbackOptions {
	enabled?: boolean;
	apiKey?: string;
	baseUrl?: string;
	fetch?: typeof fetch;
	handler?: (
		params: ImageDescriptionParams | string,
		reason: VisionFallbackReason,
	) => Promise<LocalVisionOutcome>;
	log?: (message: string, detail?: Record<string, unknown>) => void;
}

function resolveVastApiKey(options: VisionVastFallbackOptions): string | null {
	return (
		options.apiKey?.trim() || process.env.ELIZA_VAST_API_KEY?.trim() || null
	);
}

function resolveVastBaseUrl(options: VisionVastFallbackOptions): string {
	return (
		options.baseUrl?.trim() ||
		process.env.ELIZA_VAST_BASE_URL?.trim() ||
		"https://api.vast.ai"
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

async function callVastVision(
	params: ImageDescriptionParams | string,
	options: VisionVastFallbackOptions,
): Promise<ImageDescriptionResult> {
	const apiKey = resolveVastApiKey(options);
	if (!apiKey) {
		throw new Error("VAST image fallback is not configured");
	}
	const fetchImpl = options.fetch ?? fetch;
	const response = await fetchImpl(
		`${resolveVastBaseUrl(options)}/v1/vision/describe`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(imageRequestBody(params)),
		},
	);
	if (!response.ok) {
		throw new Error(`VAST image fallback failed with ${response.status}`);
	}
	return normalizeVisionDescription(
		(await response.json()) as ImageDescriptionResult,
	);
}

export function wrapImageDescriptionHandlerWithVastFallback(
	previous: WrappedImageDescriptionHandler,
	options: VisionVastFallbackOptions = {},
): WrappedImageDescriptionHandler {
	const enabled = options.enabled ?? true;
	const log = options.log ?? (() => undefined);
	return async (params): Promise<LocalVisionOutcome> => {
		const outcome = await previous(params);
		if (!isVisionFallbackOutcome(outcome)) {
			return normalizeVisionDescription(outcome);
		}
		if (!enabled) return outcome;

		const apiKey = resolveVastApiKey(options);
		if (!options.handler && !apiKey) return outcome;

		log("[vision/vast-fallback] upstream IMAGE_DESCRIPTION fallback", {
			reason: outcome.reason,
		});
		try {
			const vastOutcome = options.handler
				? await options.handler(params, outcome.reason)
				: await callVastVision(params, options);
			if (isVisionFallbackOutcome(vastOutcome)) return vastOutcome;
			return normalizeVisionDescription(vastOutcome);
		} catch (error) {
			return {
				kind: "fallback",
				reason: "vast-error",
				cause: error instanceof Error ? error : new Error(String(error)),
			};
		}
	};
}
