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
