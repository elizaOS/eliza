<<<<<<< HEAD
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
		if (!options.handler) return outcome;

		try {
			return normalizeVisionDescription(
				await options.handler(params, outcome.reason),
			);
		} catch (err) {
			return {
				kind: "fallback",
				reason: "local-error",
				cause: err instanceof Error ? err : undefined,
=======
import type { LocalImageDescriptionHandler, LocalVisionOutcome } from "./cloud-fallback";

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
>>>>>>> origin/codex/fused-local-inference-latest-20260515
			};
		}
	};
}
