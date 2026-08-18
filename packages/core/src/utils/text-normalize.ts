/**
 * Text normalization helpers for prompt/context assembly.
 *
 * WHY: Several runtime paths need to turn mixed nested values into stable,
 * human-readable text blocks. Keeping this logic in one place makes prompt
 * construction more predictable and avoids each caller inventing slightly
 * different null/array/object coercion rules.
 */

/**
 * Flatten a mixed nested value into text fragments.
 *
 * - Arrays are recursively flattened
 * - Empty/nullish values are dropped
 * - Strings are trimmed
 * - Dates become deterministic ISO-8601 strings
 * - Objects become `key: value` fragments
 * - Scalars are stringified
 */
export function flattenTextValues(value: unknown): string[] {
	return flattenTextValuesWithAncestors(value, new WeakSet());
}

function flattenTextValuesWithAncestors(
	value: unknown,
	ancestors: WeakSet<object>,
): string[] {
	if (Array.isArray(value)) {
		if (ancestors.has(value)) {
			return [];
		}
		ancestors.add(value);
		try {
			return value.flatMap((item) =>
				flattenTextValuesWithAncestors(item, ancestors),
			);
		} finally {
			ancestors.delete(value);
		}
	}

	if (value == null) {
		return [];
	}

	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? [trimmed] : [];
	}

	if (typeof value === "object") {
		const dateTimestamp = getDateTimestamp(value);
		if (dateTimestamp !== undefined) {
			return Number.isNaN(dateTimestamp)
				? [Date.prototype.toString.call(value)]
				: [Date.prototype.toISOString.call(value)];
		}
	}

	if (typeof value === "object") {
		if (ancestors.has(value)) {
			return [];
		}
		ancestors.add(value);
		try {
			return Object.entries(value as Record<string, unknown>).flatMap(
				([key, inner]) => {
					const innerText = flattenTextValuesWithAncestors(
						inner,
						ancestors,
					).join(", ");
					return innerText ? [`${key}: ${innerText}`] : [];
				},
			);
		} finally {
			ancestors.delete(value);
		}
	}

	return [String(value)];
}

function getDateTimestamp(value: object): number | undefined {
	try {
		if (
			!(value instanceof Date) &&
			Object.prototype.toString.call(value) !== "[object Date]"
		) {
			return undefined;
		}
		return Date.prototype.getTime.call(value);
	} catch {
		// error-policy:J3 Reject spoofed or otherwise non-Date objects.
		return undefined;
	}
}

/**
 * Convert a mixed nested value into a multi-line text block.
 */
export function toMultilineText(value: unknown): string {
	return flattenTextValues(value).join("\n");
}
