/**
 * Structured error every WS3 backend throws when it can't serve a
 * request. Mirrors `VisionBackendUnavailableError` so the arbiter / WS3
 * provider handler can surface a single typed failure mode upward.
 */
export class ImageGenBackendUnavailableError extends Error {
	readonly code = "IMAGE_GEN_BACKEND_UNAVAILABLE";
	constructor(
		readonly backendId: string,
		readonly reason:
			| "binary_missing"
			| "binary_version_mismatch"
			| "model_missing"
			| "binding_unavailable"
			| "unsupported_runtime"
			| "unsupported_request"
			| "subprocess_failed",
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "ImageGenBackendUnavailableError";
	}
}

/** Tells callers whether a thrown error came from a backend availability check. */
export function isImageGenUnavailable(
	err: unknown,
): err is ImageGenBackendUnavailableError {
	return (
		err instanceof ImageGenBackendUnavailableError ||
		(typeof err === "object" &&
			err !== null &&
			(err as { code?: unknown }).code === "IMAGE_GEN_BACKEND_UNAVAILABLE")
	);
}
