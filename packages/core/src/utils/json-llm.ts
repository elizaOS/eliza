/**
 * JSON parsing helpers for LLM output.
 *
 * WHY: Model output commonly includes trailing commas, single quotes, unquoted
 * keys, or fenced code blocks. Keep the tolerant extraction/parsing path in a
 * dedicated helper so callers parsing LLM text do not each reinvent it.
 */

import JSON5 from "json5";
import { unwrapWholeCodeFence } from "./code-fence.ts";

const FENCE_LANGUAGES = ["json5", "json"] as const;

// A fenced block embedded in prose. Both delimiters must own their line: a
// valid JSON string cannot contain a raw newline, so a ``` that starts a line
// is never string content, whereas an unanchored match would treat the first
// ``` anywhere in the text (including one inside a string value) as the
// opening fence and the next one as the closing fence. The alternation lists
// json5 before json because nothing anchors the end of the info string.
const jsonBlockPattern =
	/^[ \t]*```(?:json5|json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*\r?$/im;

type ParseAttempt =
	| { ok: true; value: Record<string, unknown> | unknown[] }
	| { ok: false; error: unknown };

function parseCandidate(candidate: string): ParseAttempt {
	// JSON5 already handles unquoted keys, single quotes, and trailing commas.
	try {
		const parsed = JSON5.parse(candidate);
		if (parsed === null || typeof parsed !== "object") {
			throw new Error("Parsed JSON must be an object or array");
		}
		return { ok: true, value: parsed as Record<string, unknown> | unknown[] };
	} catch (error) {
		// error-policy:J3 model output is untrusted input; an unparseable
		// candidate is an explicit failed attempt that the caller reports.
		return { ok: false, error };
	}
}

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

	const trimmed = text.trim();

	// The whole text first: when it is already valid JSON, any ``` inside it
	// is string data and must not be mistaken for a fence.
	const direct = parseCandidate(trimmed);
	if (direct.ok) return direct.value;

	// Then a fence wrapping the entire value (including compact and json5
	// forms), then a fenced block surrounded by prose.
	const wholeFence = unwrapWholeCodeFence(trimmed, FENCE_LANGUAGES);
	const embedded = wholeFence === null ? trimmed.match(jsonBlockPattern) : null;
	const fenced = wholeFence ?? embedded?.[1] ?? null;
	const attempt = fenced === null ? direct : parseCandidate(fenced.trim());
	if (attempt.ok) return attempt.value;

	// error-policy:J2 Give callers a stable parse error while retaining the
	// native JSON parser's location and syntax detail as the cause.
	throw new Error("Failed to parse invalid JSON", { cause: attempt.error });
}
