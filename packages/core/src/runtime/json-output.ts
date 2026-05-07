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
		return null;
	}

	return null;
}

export function stringifyForModel(value: unknown): string {
	return JSON.stringify(value, null, 2);
}
