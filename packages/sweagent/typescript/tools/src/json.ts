/**
 * Strict JSON-compatible type definitions.
 * These replace `unknown` and `any` for JSON-compatible data.
 */

/**
 * JSON primitive types
 */
export type JsonPrimitive = string | number | boolean | null;

/**
 * JSON-compatible value type (strict alternative to `unknown`)
 */
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * JSON object type (strict alternative to `Record<string, unknown>`)
 */
export type JsonObject = { [key: string]: JsonValue };
