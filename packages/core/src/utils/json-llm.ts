/**
 * JSON parsing helpers for LLM output.
 *
 * WHY: Model output commonly includes trailing commas, single quotes, unquoted
 * keys, or fenced code blocks. Keep the tolerant extraction/parsing path in a
 * dedicated helper so callers parsing LLM text do not each reinvent it.
 */

import JSON5 from "json5";

const jsonBlockPattern =
	/```(?:[a-zA-Z0-9_-]+)?\s*\r?\n?([\s\S]*?)\r?\n?```/;

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
	} catch (primaryError) {
		// If initial parse failed and no code fence was present, attempt substring extraction for { ... } or [ ... ]
		if (!match) {
			const firstBrace = textToParse.indexOf("{");
			const lastBrace = textToParse.lastIndexOf("}");
			const firstBracket = textToParse.indexOf("[");
			const lastBracket = textToParse.lastIndexOf("]");

			let candidate: string | undefined;
			if (
				firstBrace !== -1 &&
				lastBrace !== -1 &&
				lastBrace > firstBrace &&
				(firstBracket === -1 || firstBrace < firstBracket)
			) {
				candidate = textToParse.slice(firstBrace, lastBrace + 1);
			} else if (
				firstBracket !== -1 &&
				lastBracket !== -1 &&
				lastBracket > firstBracket
			) {
				candidate = textToParse.slice(firstBracket, lastBracket + 1);
			}

			if (candidate) {
				try {
					const parsedCandidate = JSON5.parse(candidate);
					if (
						parsedCandidate !== null &&
						typeof parsedCandidate === "object"
					) {
						return parsedCandidate as
							| Record<string, unknown>
							| unknown[];
					}
				} catch {
					// Fall through to throw stable parse error
				}
			}
		}

		// error-policy:J2 Give callers a stable parse error while retaining the
		// native JSON parser's location and syntax detail as the cause.
		throw new Error("Failed to parse invalid JSON", { cause: primaryError });
	}
}
