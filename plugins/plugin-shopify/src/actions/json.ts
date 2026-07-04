/**
 * Parses a string into a plain JSON object, returning `null` on parse failure
 * or when the value is not an object (arrays included). Used by the SHOPIFY
 * handlers to read the LLM intent-classifier output without throwing.
 */
export function parseJsonObject<T extends Record<string, unknown>>(
  value: string,
): T | null {
  try {
    const parsed: unknown = JSON.parse(value.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as T)
      : null;
  } catch {
    return null;
  }
}
