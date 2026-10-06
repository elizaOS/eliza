/**
 * Formats unknown diagnostic values without letting failed property access or
 * coercion mask the original runtime failure.
 */

function isPropertyContainer(
	value: unknown,
): value is Record<PropertyKey, unknown> | ((...args: never[]) => unknown) {
	return (
		value !== null && (typeof value === "object" || typeof value === "function")
	);
}

export function readDiagnosticProperty(
	value: unknown,
	property: PropertyKey,
): unknown {
	if (!isPropertyContainer(value)) return undefined;
	try {
		return Reflect.get(value, property);
	} catch {
		// error-policy:J7 diagnostic inspection must not mask the original failure
		return undefined;
	}
}

function readNonBlankString(
	value: unknown,
	property: PropertyKey,
): string | null {
	const candidate = readDiagnosticProperty(value, property);
	return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

function safeString(value: unknown): string {
	try {
		return String(value);
	} catch {
		// error-policy:J7 diagnostic coercion must not mask the original failure
		try {
			return Object.prototype.toString.call(value);
		} catch {
			// error-policy:J7 hostile type-tag access still needs printable output
			return "[unstringifiable error]";
		}
	}
}

export function formatDiagnosticError(value: unknown): string {
	return (
		readNonBlankString(value, "stack") ??
		readNonBlankString(value, "message") ??
		safeString(value)
	);
}

/** Extract an Error message or coerce a thrown value without masking the original failure. */
export function formatError(error: unknown): string {
	try {
		return String(error instanceof Error ? error.message : error);
	} catch {
		// error-policy:J7 error formatting must not mask the failure being
		// reported; continue with a primitive-conversion-free representation.
		try {
			// Type tags avoid primitive coercion but can still invoke a hostile getter.
			return Object.prototype.toString.call(error);
		} catch {
			// error-policy:J7 diagnostics must remain printable even for values
			// whose type-tag access is itself hostile.
			return "[unstringifiable error]";
		}
	}
}

/** Preserve diagnostic stacks without allowing hostile thrown values to mask an error. */
export function formatErrorWithStack(error: unknown): string {
	return formatDiagnosticError(error);
}

/** Classify an error as a fetch/AbortSignal timeout. */
export function isTimeoutError(error: unknown): boolean {
	const name = readDiagnosticProperty(error, "name");
	if (name === "TimeoutError" || name === "AbortError") return true;
	const message =
		typeof error === "string"
			? error
			: readDiagnosticProperty(error, "message");
	if (typeof message !== "string") return false;
	const normalized = message.toLowerCase();
	return normalized.includes("timed out") || normalized.includes("timeout");
}

/** Classify a fetch Response as a redirect (3xx). */
export function isRedirectResponse(response: Response): boolean {
	if (
		!response ||
		typeof response !== "object" ||
		typeof response.status !== "number" ||
		!Number.isFinite(response.status)
	) {
		return false;
	}
	return response.status >= 300 && response.status < 400;
}

/** Extract a human-readable message from an unknown caught value. */
export const errorMessage = formatError;
