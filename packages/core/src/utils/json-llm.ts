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

	const safeText = text.length > 100_000 ? text.slice(0, 100_000) : text;
	// First try to extract JSON from code blocks if present
	const match = safeText.match(jsonBlockPattern);
	const textToParse = match ? match[1].trim() : safeText.trim();

	// Use JSON5.parse directly - it already handles unquoted keys, single quotes, trailing commas
	try {
		return JSON5.parse(textToParse) as Record<string, unknown>;
	} catch {
		throw new Error("Failed to parse invalid JSON");
	}
}
