/**
 * Canonical error-message extractor. Returns an `Error`'s `.message` and
 * `String(value)` for everything else.
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
