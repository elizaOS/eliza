/**
 * Canonical error-message extractor and Error normalizer. Returns an `Error`'s
 * `.message` or formats unknown values into safe strings and standard Error
 * instances, preserving underlying cause context.
 *
 * Both `error.message` and `String(error)` can throw: `String()` raises
 * `TypeError: Cannot convert object to primitive value` on a null-prototype
 * object or one whose `toString` / `Symbol.toPrimitive` is poisoned, and a
 * pathological `Error` subclass can expose a throwing `message` getter. This
 * runs on error paths — it must never itself throw and mask the original
 * failure — so both extraction attempts are guarded and fall back to a
 * `toString`-free description of the value's type tag.
 */
export function formatError(error: unknown): string {
	try {
		return error instanceof Error ? error.message : String(error);
	} catch {
		// error-policy:J7 error formatting must not mask the failure being
		// reported; continue with a primitive-conversion-free representation.
		try {
			// Object.prototype.toString ignores user-defined `toString` /
			// `Symbol.toPrimitive`, so it cannot be poisoned: e.g. "[object Object]".
			return Object.prototype.toString.call(error);
		} catch {
			// error-policy:J7 diagnostics must remain printable even for values
			// whose type-tag access is itself hostile.
			return "[unstringifiable error]";
		}
	}
}

/**
 * Normalizes an unknown value into a standard Error instance, preserving existing Errors
 * or creating a new Error with formatted message and preserved cause.
 *
 * @param error The value to normalize.
 * @param fallbackMessage Fallback message when error produces a blank or degenerate message.
 */
export function toError(
	error: unknown,
	fallbackMessage = "Unknown error",
): Error {
	if (error instanceof Error) {
		return error;
	}
	if (error === null || error === undefined) {
		return new Error(fallbackMessage);
	}
	if (typeof error === "string") {
		const trimmed = error.trim();
		return new Error(trimmed.length > 0 ? trimmed : fallbackMessage, {
			cause: error,
		});
	}
	const message = formatError(error).trim();
	return new Error(message.length > 0 ? message : fallbackMessage, {
		cause: error,
	});
}
