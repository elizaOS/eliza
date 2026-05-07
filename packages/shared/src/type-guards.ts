/**
 * Tiny runtime type guards used everywhere we narrow `unknown` values coming
 * from JSON boundaries (HTTP bodies, `State.data`, provider results, config
 * files, etc.). Centralised here so we stop redefining them in every file.
 */

export type UnknownRecord = Record<string, unknown>;

export function isPlainObject(value: unknown): value is UnknownRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

/**
 * Narrow an `unknown` to a plain object record.
 *
 * Returns `null` for anything that isn't a non-array object — primitives,
 * `null`/`undefined`, and arrays. Use this at boundaries where you're about
 * to read properties and want a typed target.
 */
export function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as UnknownRecord;
}

/**
 * Variant of {@link asRecord} that returns `undefined` instead of `null`
 * when the value is not an object record. Useful when you want to chain
 * with `?.` operators.
 */
export function asRecordOrUndefined(value: unknown): UnknownRecord | undefined {
  return asRecord(value) ?? undefined;
}

/**
 * Narrow `unknown` to an array of plain objects. Matches the loose shape of
 * `Memory[]` etc. — each entry is truthy and typeof-object, no further
 * structural checks (callers usually pick specific fields after).
 */
export function asObjectArray(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is UnknownRecord =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}

/** Narrow `unknown` to a non-empty trimmed string, else undefined. */
export function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
