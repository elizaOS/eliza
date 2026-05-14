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
		const objectText = extractFirstJsonObject(candidate);
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
