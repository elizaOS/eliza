/**
 * Typed unavailability error for ASR backends. Mirrors
 * `ImageGenBackendUnavailableError` from `../imagegen/errors`.
 *
 * Backends throw this to signal that a specific request cannot be served
 * (`unsupported_request`, `model_missing`, `load_failed`, ...) so the
 * arbiter / caller can surface an actionable message rather than a generic
 * "transcription failed".
 */

export type AsrUnavailableReason =
	| "unsupported_request"
	| "model_missing"
	| "load_failed"
	| "decode_failed"
	| "aborted";

export class AsrBackendUnavailableError extends Error {
	readonly code = "ASR_BACKEND_UNAVAILABLE";

	constructor(
		readonly backendId: string,
		readonly reason: AsrUnavailableReason,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "AsrBackendUnavailableError";
	}

	toJSON(): Record<string, string> {
		return {
			code: this.code,
			backendId: this.backendId,
			reason: this.reason,
			message: this.message,
		};
	}
}

export function isAsrBackendUnavailable(
	err: unknown,
): err is AsrBackendUnavailableError {
	return (
		err instanceof AsrBackendUnavailableError ||
		(typeof err === "object" &&
			err !== null &&
			(err as { code?: unknown }).code === "ASR_BACKEND_UNAVAILABLE")
	);
}
