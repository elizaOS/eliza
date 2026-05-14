export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function nullableString(value: unknown): string | null | undefined {
	if (value === null) return null;
	return typeof value === "string" ? value : undefined;
}

export function optionalString(value: unknown): string | undefined | false {
	if (value === undefined) return undefined;
	return typeof value === "string" ? value : false;
}

export function requiredString(
	body: Record<string, unknown>,
	key: string,
): string | null {
	const value = body[key];
	return typeof value === "string" ? value : null;
}

export function requiredBoolean(
	body: Record<string, unknown>,
	key: string,
): boolean | null {
	const value = body[key];
	return typeof value === "boolean" ? value : null;
}

export function hasBooleanFields(
	body: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	return keys.every((key) => typeof body[key] === "boolean");
}

export function optionalFiniteNumber(
	value: unknown,
): number | undefined | false {
	if (value === undefined) return undefined;
	return typeof value === "number" && Number.isFinite(value) ? value : false;
}
