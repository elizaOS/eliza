/**
 * Boolean parsing utilities.
 *
 * Provides flexible boolean parsing from string values
 * with configurable truthy/falsy representations.
 *
 * @module utils/boolean
 */

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

/**
 * Parse a value as a boolean.
 *
 * Handles:
 * - Boolean values (passed through)
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
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const truthy = options.truthy ?? DEFAULT_TRUTHY;
  const falsy = options.falsy ?? DEFAULT_FALSY;
  const truthySet =
    truthy === DEFAULT_TRUTHY ? DEFAULT_TRUTHY_SET : new Set(truthy);
  const falsySet = falsy === DEFAULT_FALSY ? DEFAULT_FALSY_SET : new Set(falsy);
  if (truthySet.has(normalized)) {
    return true;
  }
  if (falsySet.has(normalized)) {
    return false;
  }
  return undefined;
}
