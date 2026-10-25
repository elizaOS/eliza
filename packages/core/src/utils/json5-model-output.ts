/**
 * Parses model JSON with explicit JSON5 tolerance for quoted keys, trailing commas, and code
 * fences.
 */

import JSON5 from "json5";

const jsonBlockPattern =
	/```(?:(?:json5|json)(?![A-Za-z0-9_-]))?\s*\r?\n?([\s\S]*?)\r?\n?```/i;

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

	// Parse complete JSON first: code fences can be part of a string value.
	try {
		let parsed: unknown;
		try {
			parsed = JSON5.parse(text.trim());
		} catch (error) {
			const match = text.match(jsonBlockPattern);
			if (!match) throw error;
			parsed = JSON5.parse(match[1].trim());
		}
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
