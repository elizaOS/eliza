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
	apiKey?: string;
	baseUrl?: string;
	fetch?: typeof fetch;
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
		const handler =
			options.handler ??
			(options.apiKey
				? async (fallbackParams: ImageDescriptionParams | string) =>
						describeWithHttpFallback(fallbackParams, {
							apiKey: options.apiKey as string,
							baseUrl: options.baseUrl ?? "https://api.vast.ai",
							fetchImpl: options.fetch ?? fetch,
						})
				: null);
		if (!handler) return outcome;

		try {
			return normalizeVisionDescription(
				await handler(params, outcome.reason),
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
	options: { apiKey: string; baseUrl: string; fetchImpl: typeof fetch },
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
				authorization: `Bearer ${options.apiKey}`,
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
