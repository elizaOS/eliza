/**
 * Serializes server values for JavaScript literals embedded in HTML script
 * elements, preserving JSON semantics without allowing an HTML end tag to
 * terminate the script early.
 */

/** Serialize a defined value for interpolation into an inline script. */
export function serializeInlineScriptValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Inline script values must be JSON-serializable");
  }
  return serialized
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
