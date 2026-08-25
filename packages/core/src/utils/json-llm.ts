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
 * @param options.strict - When true, skip the prose-extraction fallback and
 *   only parse the full trimmed text. Callers on trust, elevation, or other
 *   authorization paths should use strict mode to preserve the fail-closed
 *   contract: prose that is not valid JSON produces null/error, never a
 *   partial extraction.
 * @returns Parsed object/array
 * @throws {Error} If the JSON is invalid or parsing fails
 */
export function extractAndParseJSONObjectFromText(
	text: string,
	options?: { strict?: boolean },
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
		if (options?.strict) {
			// error-policy:J2 Give callers a stable parse error while retaining the
			// native JSON parser's location and syntax detail as the cause.
			throw new Error("Failed to parse invalid JSON", { cause: error });
		}

		// If direct parse failed, attempt to find a JSON object or array span
		// within the text. Try the object candidate first, then the array
		// candidate, and return the first one that parses successfully.
		const candidates = ["{", "["].map((open) => {
			const start = textToParse.indexOf(open);
			if (start === -1) return null;
			const close = open === "{" ? "}" : "]";
			const end = textToParse.lastIndexOf(close);
			return end > start ? textToParse.slice(start, end + 1) : null;
		});

		for (const candidate of candidates) {
			if (!candidate) continue;
			try {
				const fallbackParsed = JSON5.parse(candidate);
				if (fallbackParsed !== null && typeof fallbackParsed === "object") {
					return fallbackParsed as Record<string, unknown> | unknown[];
				}
			} catch {
				// Try the next candidate
			}
		}

		// error-policy:J2 Give callers a stable parse error while retaining the
		// native JSON parser's location and syntax detail as the cause.
		throw new Error("Failed to parse invalid JSON", { cause: error });
	}
}
