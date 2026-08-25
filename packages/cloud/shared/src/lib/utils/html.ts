/** Encodes Cloud response values at HTML text, attribute, and script boundaries. */

/** Escape a string for safe interpolation into HTML text/attributes. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Serialize a defined value for a JavaScript literal inside an HTML script
 * element. JSON quoting alone does not prevent a literal `</script>` from
 * terminating the element before the JavaScript parser sees the string.
 */
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
