/**
 * Structural recognition of expected local-embedding unavailability.
 *
 * The local-inference provider owns a typed `LOCAL_INFERENCE_UNAVAILABLE`
 * failure with a stable `reason` field. When the backend or capability is
 * absent by design, keyword recall is the intended degraded mode — that must
 * not fill `RECENT_ERRORS` or escalate on every ordinary query. Core must not
 * import `plugin-local-inference` (dependency edge runs the other way), so this
 * predicate matches the documented `code`/`modelType`/`reason` shape only.
 *
 * `invalid_input`, `invalid_output`, lookalike codes with a foreign reason, and
 * unknown failures remain reportable.
 */

import { ModelType } from "../types/model";

const EXPECTED_UNAVAILABLE_REASONS = new Set([
	"backend_unavailable",
	"capability_unavailable",
]);

export interface ModelProviderFailureDetails {
	code?: string;
	modelType?: string;
	provider?: string;
	reason?: string;
}

/** Read the stable cross-package error fields exposed by model providers. */
export function modelProviderFailureDetails(
	error: unknown,
): ModelProviderFailureDetails {
	if (typeof error !== "object" || error === null) return {};
	const candidate = error as Record<string, unknown>;
	return {
		code: typeof candidate.code === "string" ? candidate.code : undefined,
		modelType:
			typeof candidate.modelType === "string" ? candidate.modelType : undefined,
		provider:
			typeof candidate.provider === "string" ? candidate.provider : undefined,
		reason: typeof candidate.reason === "string" ? candidate.reason : undefined,
	};
}

/**
 * True when `error` is the local provider's expected embedding-unavailable
 * state that should fail open to keyword recall without diagnostic escalation.
 */
export function isExpectedLocalEmbeddingUnavailability(
	error: unknown,
): boolean {
	const details = modelProviderFailureDetails(error);
	return (
		details.code === "LOCAL_INFERENCE_UNAVAILABLE" &&
		details.modelType === ModelType.TEXT_EMBEDDING &&
		details.reason !== undefined &&
		EXPECTED_UNAVAILABLE_REASONS.has(details.reason)
	);
}
