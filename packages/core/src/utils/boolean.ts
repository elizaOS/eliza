/** Parses string booleans against configurable truthy and falsy vocabularies. */

/**
 * Options for boolean parsing.
 */
export type BooleanParseOptions = {
	/** Values that should parse as true */
	truthy?: string[];
	/** Values that should parse as false */
	falsy?: string[];
};

const DEFAULT_TRUTHY = ["true", "1", "yes", "on"] as const;
const DEFAULT_FALSY = ["false", "0", "no", "off"] as const;
const DEFAULT_TRUTHY_SET = new Set<string>(DEFAULT_TRUTHY);
const DEFAULT_FALSY_SET = new Set<string>(DEFAULT_FALSY);
const TEXT_TRUTHY = ["yes", "y", "true", "t", "1", "on", "enable"] as const;
const TEXT_FALSY = ["no", "n", "false", "f", "0", "off", "disable"] as const;

/**
 * Parse a value as a boolean.
 *
 * Handles:
 * - Boolean values (passed through)
 * - Numeric values (1 => true, 0 => false, matching numeric tokens in truthy/falsy sets)
 * - String values ("true", "1", "yes", "on" => true; "false", "0", "no", "off" => false)
 * - Custom truthy/falsy values via options
 *
 * @param value - Value to parse
 * @param options - Parsing options
 * @returns Boolean value or undefined if not parseable
 *
 * @example
 * ```ts
 * parseBooleanValue(true) // => true
 * parseBooleanValue(1) // => true
 * parseBooleanValue(0) // => false
 * parseBooleanValue("yes") // => true
 * parseBooleanValue("1") // => true
 * parseBooleanValue("false") // => false
 * parseBooleanValue("no") // => false
 * parseBooleanValue("maybe") // => undefined
 * parseBooleanValue("enabled", { truthy: ["enabled"] }) // => true
 * ```
 */
export function parseBooleanValue(
	value: unknown,
	options: BooleanParseOptions = {},
): boolean | undefined {
	if (typeof value === "boolean") {
		return value;
	}
	let normalized: string;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			return undefined;
		}
		normalized = String(value);
	} else if (typeof value === "string") {
		normalized = value.trim().toLowerCase();
		if (!normalized) {
			return undefined;
		}
	} else {
		return undefined;
	}
	const truthy = options.truthy ?? DEFAULT_TRUTHY;
	const falsy = options.falsy ?? DEFAULT_FALSY;
	const truthySet =
		truthy === DEFAULT_TRUTHY
			? DEFAULT_TRUTHY_SET
			: new Set(truthy.map((v) => v.trim().toLowerCase()));
	const falsySet =
		falsy === DEFAULT_FALSY
			? DEFAULT_FALSY_SET
			: new Set(falsy.map((v) => v.trim().toLowerCase()));
	if (truthySet.has(normalized)) {
		return true;
	}
	if (falsySet.has(normalized)) {
		return false;
	}
	return undefined;
}

/**
 * Parse user/config text as a boolean, defaulting invalid values to false.
 *
 * WHY: A few older call sites intentionally treat unknown text as "off" rather
 * than propagating `undefined`. This preserves that behavior while still routing
 * through the shared boolean parser.
 */
export function parseBooleanText(
	value: string | number | boolean | undefined | null,
): boolean {
	return (
		parseBooleanValue(value, {
			truthy: [...TEXT_TRUTHY],
			falsy: [...TEXT_FALSY],
		}) ?? false
	);
}
