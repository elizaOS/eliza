export function parseJsonObject<T extends object>(raw: string): T | null {
	const trimmed = raw.trim();
	if (!trimmed) {
		return null;
	}

	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	const candidate = fenced?.[1] ?? trimmed;

	try {
		const parsed = JSON.parse(candidate);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as T;
		}
	} catch {
		const repairedCandidate = repairJsonStringEscapes(candidate);
		if (repairedCandidate !== candidate) {
			const parsed = parseJsonObjectCandidate<T>(repairedCandidate);
			if (parsed) return parsed;
		}
		for (const source of [candidate, repairedCandidate]) {
			const objectText = extractFirstJsonObject(source);
			if (!objectText) continue;
			const parsed = parseJsonObjectCandidate<T>(objectText);
			if (parsed) return parsed;
			const repairedObjectText = repairJsonStringEscapes(objectText);
			if (repairedObjectText !== objectText) {
				const repairedParsed = parseJsonObjectCandidate<T>(repairedObjectText);
				if (repairedParsed) return repairedParsed;
			}
		}
		return null;
	}

	return null;
}

function parseJsonObjectCandidate<T extends object>(raw: string): T | null {
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as T;
		}
	} catch {
		return null;
	}
	return null;
}

/**
 * Best-effort repair for provider outputs that contain logical string content
 * but invalid JSON string bytes. It only rewrites characters while inside a
 * quoted JSON string:
 * - raw LF/CR/tab/control characters become JSON escapes
 * - a backslash that is not starting a valid JSON escape becomes a literal
 *   escaped backslash
 */
export function repairJsonStringEscapes(raw: string): string {
	let output = "";
	let inString = false;
	for (let i = 0; i < raw.length; i++) {
		const char = raw[i] ?? "";
		if (!inString) {
			output += char;
			if (char === '"') inString = true;
			continue;
		}
		if (char === '"') {
			output += char;
			inString = false;
			continue;
		}
		if (char === "\\") {
			const next = raw[i + 1];
			if (next && isValidSimpleJsonEscape(next)) {
				output += char + next;
				i++;
				continue;
			}
			if (next === "u" && isValidUnicodeEscape(raw.slice(i + 2, i + 6))) {
				output += raw.slice(i, i + 6);
				i += 5;
				continue;
			}
			output += "\\\\";
			continue;
		}
		const code = char.charCodeAt(0);
		if (char === "\n") output += "\\n";
		else if (char === "\r") output += "\\r";
		else if (char === "\t") output += "\\t";
		else if (code < 0x20) {
			output += `\\u${code.toString(16).padStart(4, "0")}`;
		} else {
			output += char;
		}
	}
	return output;
}

function isValidSimpleJsonEscape(char: string): boolean {
	return (
		char === '"' ||
		char === "\\" ||
		char === "/" ||
		char === "b" ||
		char === "f" ||
		char === "n" ||
		char === "r" ||
		char === "t"
	);
}

function isValidUnicodeEscape(text: string): boolean {
	return /^[0-9a-fA-F]{4}$/.test(text);
}

function extractFirstJsonObject(raw: string): string | null {
	const start = raw.indexOf("{");
	if (start < 0) return null;

	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < raw.length; index++) {
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
			depth++;
			continue;
		}
		if (char !== "}") continue;
		depth--;
		if (depth === 0) {
			return raw.slice(start, index + 1);
		}
	}
	return null;
}

export function stringifyForModel(value: unknown): string {
	return JSON.stringify(value, null, 2);
}
