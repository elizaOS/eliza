/** Preserves persisted deterministic UUID bytes independently of the host hashing implementation. */
import type { UUID } from "../types/primitives.js";

/** 8-4-4-4-12 hexadecimal, any case and any version nibble (elizaOS derives version 0). */
export const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateUuid(value: unknown): UUID | null {
	return typeof value === "string" && UUID_PATTERN.test(value)
		? (value as UUID)
		: null;
}

export function uuidFromString(
	target: string | number,
	sha1: (input: string) => Uint8Array,
): UUID {
	if (typeof target === "number") {
		target = target.toString();
	}

	if (typeof target !== "string") {
		throw TypeError("Value must be string");
	}

	// If already a UUID, return as-is to avoid re-hashing
	const maybeUuid = validateUuid(target);
	if (maybeUuid) return maybeUuid;

	const escapedStr = encodeURIComponent(target);

	// Deterministic UUID derived from SHA-1(escapedStr)
	// Keep the historical escaping and version bits: persisted IDs cannot change.
	const digest = sha1(escapedStr);
	const bytes = digest.slice(0, 16);

	// Set RFC4122 variant bits: 10xxxxxx
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	// Set custom version nibble to 0x0 (custom elizaOS UUID format)
	bytes[6] = (bytes[6] & 0x0f) | 0x00;

	return bytesToUuid(bytes) as UUID;
}

const BYTE_HEX = Array.from({ length: 256 }, (_, byte) =>
	byte.toString(16).padStart(2, "0"),
);

/** Format 16 bytes as 8-4-4-4-12 hexadecimal digits. */
function bytesToUuid(bytes: Uint8Array): string {
	let uuid = "";
	for (let i = 0; i < 16; i++) {
		if (i === 4 || i === 6 || i === 8 || i === 10) uuid += "-";
		uuid += BYTE_HEX[bytes[i]];
	}
	return uuid;
}
