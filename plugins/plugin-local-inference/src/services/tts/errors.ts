/**
 * Structured error every TTS backend throws when it can't serve a
 * request. Mirrors `ImageGenBackendUnavailableError` so the arbiter / WS5
 * provider handler can surface a single typed failure mode upward.
 *
 * `unsupported_request` is the only reason callers retry against a
 * different backend (e.g. unknown voice id on Kokoro → fall through to
 * Edge TTS via the runtime model registry priority list). All other
 * reasons indicate a missing local install and the caller should surface
 * the actionable message verbatim — no silent fallback to a cloud
 * provider for installer / weights issues (AGENTS.md §3).
 */
export class TtsBackendUnavailableError extends Error {
	readonly code = "TTS_BACKEND_UNAVAILABLE";
	constructor(
		readonly backendId: string,
		readonly reason:
			| "binary_missing"
			| "binary_version_mismatch"
			| "model_missing"
			| "tokenizer_missing"
			| "voice_preset_missing"
			| "voice_unknown"
			| "binding_unavailable"
			| "unsupported_runtime"
			| "unsupported_request"
			| "subprocess_failed",
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "TtsBackendUnavailableError";
	}
}

/** Tells callers whether a thrown error came from a backend availability check. */
export function isTtsUnavailable(
	err: unknown,
): err is TtsBackendUnavailableError {
	return (
		err instanceof TtsBackendUnavailableError ||
		(typeof err === "object" &&
			err !== null &&
			(err as { code?: unknown }).code === "TTS_BACKEND_UNAVAILABLE")
	);
}
