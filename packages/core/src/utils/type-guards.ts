/**
 * Runtime type guards that narrow `unknown` to record-shaped values.
 * `isPlainObject` accepts only object-literal / null-prototype objects,
 * rejecting built-ins (Date, Map, typed arrays, Error, Promise, …) and class
 * instances; `isObjectRecord` is the looser any-non-null-non-array-object check;
 * `asRecord` / `asRecordOrUndefined` narrow-or-nullify for safe property access.
 */
export function isPlainObject(
	value: unknown,
): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") {
		return false;
	}

	// Plain records have exactly the intrinsic Object prototype or no prototype.
	// Reading an arbitrary prototype's `constructor` can execute a getter and is
	// spoofable with `{ constructor: Object }`.
	const proto = Object.getPrototypeOf(value);
	return proto === null || proto === Object.prototype;
}

export function isObjectRecord(
	value: unknown,
): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return isPlainObject(value) ? value : null;
}

export function asRecordOrUndefined(
	value: unknown,
): Record<string, unknown> | undefined {
	return asRecord(value) ?? undefined;
}
