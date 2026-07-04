/**
 * Classifies model-call errors as transient (worth retrying) by scanning the
 * error message for known rate-limit, overload, timeout, and 5xx signatures.
 * Retry logic around model invocations consumes this to decide whether to back
 * off and try again versus surface the failure.
 */
const TRANSIENT_MODEL_ERROR_PATTERNS = [
	"service temporarily unavailable",
	"temporarily unavailable",
	"rate limit",
	"too many requests",
	"overloaded",
	"socket connection was closed unexpectedly",
	"econnreset",
	"econnrefused",
	"etimedout",
	"timeout",
	"timed out",
	"529",
	"503",
	"502",
	"504",
];

export function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isTransientModelError(error: unknown): boolean {
	const message = getErrorMessage(error).toLowerCase();
	return TRANSIENT_MODEL_ERROR_PATTERNS.some((pattern) =>
		message.includes(pattern),
	);
}
