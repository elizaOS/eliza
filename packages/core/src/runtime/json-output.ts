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
		const objectText = extractJsonObjects(candidate)[0];
		if (!objectText) return null;
		try {
			const parsed = JSON.parse(objectText);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as T;
			}
		} catch {
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
