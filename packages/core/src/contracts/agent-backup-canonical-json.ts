/**
 * Canonical JSON for agent backup contracts: sorted object keys, no
 * whitespace, and only safe non-negative integers as numbers. Manifest
 * digests and restore receipts hash this exact byte form, so every backup
 * contract serializes through this one implementation.
 */

export interface CanonicalBackupJsonErrors {
	readonly nonCanonicalNumber: string;
	readonly nonJsonValue: string;
}

const MANIFEST_ERRORS: CanonicalBackupJsonErrors = {
	nonCanonicalNumber:
		"Canonical backup JSON only permits safe, non-negative integers",
	nonJsonValue: "Canonical backup JSON contains a non-JSON value",
};

export function canonicalBackupJson(
	value: unknown,
	errors: CanonicalBackupJsonErrors = MANIFEST_ERRORS,
): string {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string"
	) {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
			throw new TypeError(errors.nonCanonicalNumber);
		}
		return String(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalBackupJson(entry, errors)).join(",")}]`;
	}
	if (typeof value !== "object") {
		throw new TypeError(errors.nonJsonValue);
	}
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map(
			(key) =>
				`${JSON.stringify(key)}:${canonicalBackupJson(record[key], errors)}`,
		)
		.join(",")}}`;
}
