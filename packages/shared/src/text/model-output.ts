/**
 * JSON parsing helpers for LLM output.
 *
 * WHY: Model output commonly includes trailing commas, single quotes, unquoted
 * keys, or fenced code blocks. Keep the tolerant extraction/parsing path in a
 * dedicated helper so callers parsing LLM text do not each reinvent it.
 */

import JSON5 from "json5";

const jsonBlockPattern = /```(?:json|json5)?\s*\r?\n?([\s\S]*?)\r?\n?```/i;

/**
 * Extract and parse JSON from text using JSON5 for LLM output tolerance.
 * Throws on parse failure for invalid JSON.
 *
 * @param text - The input text containing JSON
 * @returns Parsed object/array
 * @throws {Error} If the JSON is invalid or parsing fails
 */
export function extractAndParseJSONObjectFromText(
  text: string,
): Record<string, unknown> | unknown[] {
  if (!text || typeof text !== "string") {
    throw new Error("Invalid input: text must be a non-empty string");
  }

  // First try to extract JSON from code blocks if present
  const match = text.match(jsonBlockPattern);
  const textToParse = match ? match[1].trim() : text.trim();

  // Use JSON5.parse directly - it already handles unquoted keys, single quotes, trailing commas
  try {
    const parsed = JSON5.parse(textToParse);
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("Parsed JSON must be an object or array");
    }
    return parsed as Record<string, unknown> | unknown[];
  } catch (error) {
    // error-policy:J2 Give callers a stable parse error while retaining the
    // native JSON parser's location and syntax detail as the cause.
    throw new Error("Failed to parse invalid JSON", { cause: error });
  }
}

/**
 * Parses a JSON object from raw text or a code block. JSON5 accepts common
 * model-output variations such as trailing commas, unquoted keys, and single
 * quotes. Invalid or non-object input returns null.
 *
 * @param text - The input text from which to extract and parse the JSON object.
 * @returns An object parsed from the JSON string if successful; otherwise null.
 */
export function parseJSONObjectFromText(
  text: string,
): Record<string, unknown> | null {
  try {
    const result = extractAndParseJSONObjectFromText(text);
    return Array.isArray(result) ? null : result;
  } catch (_error) {
    // error-policy:J3 model output is untrusted input; null is the explicit
    // invalid signal consumed by callers that request repair or retry.
    return null;
  }
}
