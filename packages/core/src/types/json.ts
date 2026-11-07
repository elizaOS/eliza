/** Browser-safe JSON value types; no runtime or other type-module dependencies. */
/**
 * JSON-serializable primitive value.
 */
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
	| JsonPrimitive
	| JsonValue[]
	| { [key: string]: JsonValue };

/**
 * JSON-serializable object (used for dynamic properties).
 */
export type JsonObject = { [key: string]: JsonValue };
