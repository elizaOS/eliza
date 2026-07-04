/**
 * Tolerant parsers for raw model output: unwrap code fences, extract every
 * top-level `{...}` object from noisy text, repair invalid JSON string escapes,
 * and strip leaked tool-call markup / punctuation-only replies. Used wherever
 * the runtime must salvage structure from a weak model's not-quite-valid JSON.
 */
export function parseJsonObject<T extends object>(raw: string): T | null {
	const trimmed = raw.trim();
	if (!trimmed) {
		return null;
	}

	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	const candidate = fenced?.[1] ?? trimmed;

	const parsedCandidate =
		parseObjectCandidate<T>(candidate) ??
		parseObjectCandidate<T>(repairJsonStringEscapes(candidate));
	if (parsedCandidate) {
		return parsedCandidate;
	}

	const repairedCandidate = repairJsonStringEscapes(candidate);
	const objectText =
		extractJsonObjects(candidate)[0] ??
		(repairedCandidate === candidate
			? null
			: extractJsonObjects(repairedCandidate)[0]);
	if (!objectText) return null;

	return (
		parseObjectCandidate<T>(objectText) ??
		parseObjectCandidate<T>(repairJsonStringEscapes(objectText))
	);
}

function parseObjectCandidate<T extends object>(candidate: string): T | null {
	try {
		const parsed = JSON.parse(candidate);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as T;
		}
	} catch {
		// error-policy:J3 untrusted-input sanitizing — raw model output that isn't
		// a bare JSON object is expected; retry once against the first embedded
		// object substring before reporting the candidate as invalid.
		const objectText = extractJsonObjects(candidate)[0];
		if (!objectText) return null;
		try {
			const parsed = JSON.parse(objectText);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as T;
			}
		} catch {
			// error-policy:J3 untrusted-input sanitizing — unparseable model output;
			// null is the explicit "invalid" signal, never a fake-valid default.
			return null;
		}
	}
	return null;
}

/**
 * Extract every top-level `{...}` JSON object substring from `raw`, in order.
 * Brace-depth scan that respects string literals and escapes, so braces inside
 * string values never confuse the boundaries. Weak models routinely narrate
 * multiple intents as concatenated objects (`{...}\n{...}`) rather than one
 * array — callers that took only the first silently dropped the rest.
 */
export function extractJsonObjects(raw: string): string[] {
	const objects: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < raw.length; index++) {
		const char = raw[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") {
			if (depth === 0) {
				start = index;
			}
			depth++;
			continue;
		}
		if (char !== "}" || depth === 0) {
			continue;
		}
		depth--;
		if (depth === 0 && start >= 0) {
			objects.push(raw.slice(start, index + 1));
			start = -1;
		}
	}
	return objects;
}

export function repairJsonStringEscapes(raw: string): string {
	let output = "";
	let inString = false;
	let escaped = false;

	for (let index = 0; index < raw.length; index++) {
		const char = raw[index] ?? "";
		if (!inString) {
			output += char;
			if (char === '"') {
				inString = true;
			}
			continue;
		}

		if (escaped) {
			if (char === '"' && looksLikeJsonDelimiterAfterString(raw, index + 1)) {
				output += '\\\\"';
				inString = false;
				escaped = false;
				continue;
			}
			if (isValidJsonEscape(raw, index)) {
				output += `\\${char}`;
				if (char === "u") {
					output += raw.slice(index + 1, index + 5);
					index += 4;
				}
			} else {
				output += `\\\\${escapeRawJsonStringChar(char)}`;
			}
			escaped = false;
			continue;
		}

		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === '"') {
			inString = false;
			output += char;
			continue;
		}
		output += escapeRawJsonStringChar(char);
	}

	if (escaped) {
		output += "\\\\";
	}

	return output;
}

function looksLikeJsonDelimiterAfterString(
	raw: string,
	index: number,
): boolean {
	for (let cursor = index; cursor < raw.length; cursor++) {
		const char = raw[cursor];
		if (char === " " || char === "\n" || char === "\r" || char === "\t") {
			continue;
		}
		return char === "," || char === "}" || char === "]";
	}
	return true;
}

function isValidJsonEscape(raw: string, index: number): boolean {
	const char = raw[index];
	if (
		char === '"' ||
		char === "\\" ||
		char === "/" ||
		char === "b" ||
		char === "f" ||
		char === "n" ||
		char === "r" ||
		char === "t"
	) {
		return true;
	}
	if (char !== "u") {
		return false;
	}
	const hex = raw.slice(index + 1, index + 5);
	return /^[0-9a-fA-F]{4}$/.test(hex);
}

function escapeRawJsonStringChar(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default: {
			const code = char.codePointAt(0) ?? 0;
			return code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : char;
		}
	}
}

export function stringifyForModel(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

/**
 * Clean a model-produced reply field before it reaches the user. Removes
 * structural junk that weak models emit as plain text but which is never
 * user-facing content:
 *   1. the model's NATIVE tool-call serialization emitted as text instead of a
 *      structured call, e.g.
 *      `<tool_call>WEB_FETCH<arg_key>url</arg_key><arg_value>...</arg_value></tool_call>`
 *      (observed on cerebras gpt-oss / zai; eliza routes real tool calls
 *      structurally, and this markup never appears in eliza's own format), and
 *   2. a reply that is ONLY JSON punctuation (braces/brackets/quotes/commas).
 *
 * Structural artifact removal - the sibling of the existing `[tool output:]`
 * markup stripping - not semantic-content matching. The truncated-open branch is
 * deliberately conservative: it only swallows to end-of-string when the markup is
 * unmistakably a serialized call (an uppercase ACTION token or the native
 * `<arg_key>`/`<arg_value>` markup follows), so a reply that merely *mentions*
 * `<tool_call>` in prose is preserved.
 */
export function stripJsonStructuralJunkReply(value: string): string {
	const cleaned = value
		// Fully-serialized (paired) tool-call markup leaked as text.
		.replace(/<tool_call\b[\s\S]*?<\/tool_call>/gi, "")
		// Truncated-open markup (no closing tag): only strip to end when it is
		// clearly a leaked serialization - an uppercase ACTION token or the native
		// `<arg_key>`/`<arg_value>` markup follows. Case-SENSITIVE on purpose: the
		// uppercase action token is what distinguishes a real leaked call from a
		// bare prose mention of `<tool_call>` (which must be preserved).
		.replace(
			/<tool_call\b[^>]*>\s*(?=[A-Z][A-Z0-9_]{2,}|[\s\S]*?<arg_(?:key|value)\b)[\s\S]*$/g,
			"",
		)
		.trim();
	if (!cleaned) return "";
	return /^[\s{}[\]":,]+$/.test(cleaned) ? "" : cleaned;
}
