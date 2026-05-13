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

export function optionalFiniteNumber(
	value: unknown,
): number | undefined | false {
	if (value === undefined) return undefined;
	return typeof value === "number" && Number.isFinite(value) ? value : false;
}
