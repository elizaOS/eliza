/**
 * Runtime type guards that narrow `unknown` to record-shaped values. This is
 * the single implementation module. Public names distinguish plain records from
 * arbitrary non-array objects.
 *
 * Strict: `isPlainObject` accepts only object-literal / null-prototype objects,
 * rejecting built-ins (Date, Map, typed arrays, Error, Promise, …) and class
 * instances; `asRecord` / `asRecordOrUndefined` narrow-or-nullify on that rule.
 *
 * Loose: `isObjectRecord` / `asObjectRecord` / `asObjectRecordOrUndefined`
 * accept any non-null, non-array object (class and built-in instances too);
 * `hasPlainObjectTag` checks only the `[object Object]` tag.
 */
export type UnknownRecord = Record<string, unknown>;

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

/** Loose: any non-null, non-array object, including class/built-in instances. */
export function asObjectRecord(value: unknown): UnknownRecord | null {
	return isObjectRecord(value) ? value : null;
}

export function asObjectRecordOrUndefined(
	value: unknown,
): UnknownRecord | undefined {
	return asObjectRecord(value) ?? undefined;
}

/** True for non-array objects whose `Object.prototype.toString` tag is `[object Object]`. */
export function hasPlainObjectTag(value: unknown): value is UnknownRecord {
	return (
		isObjectRecord(value) &&
		Object.prototype.toString.call(value) === "[object Object]"
	);
}

/** Loose-record elements of an array; non-arrays yield `[]`. */
export function asObjectArray(value: unknown): UnknownRecord[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is UnknownRecord => isObjectRecord(item));
}

export function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
