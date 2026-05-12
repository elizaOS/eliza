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
 * - Objects become `key: value` fragments
 * - Scalars are stringified
 */
export function flattenTextValues(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((item) => flattenTextValues(item));
	}

	if (value == null) {
		return [];
	}

	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? [trimmed] : [];
	}

	if (typeof value === "object") {
		return Object.entries(value as Record<string, unknown>).flatMap(
			([key, inner]) => {
				const innerText = flattenTextValues(inner).join(", ");
				return innerText ? [`${key}: ${innerText}`] : [];
			},
		);
	}

	return [String(value)];
}

/**
 * Convert a mixed nested value into a multi-line text block.
 */
export function toMultilineText(value: unknown): string {
	return flattenTextValues(value).join("\n");
}
