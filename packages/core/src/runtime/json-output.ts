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

export function stringifyForModel(value: unknown): string {
	return JSON.stringify(value, null, 2);
}
