/** Preserves persisted deterministic UUID bytes independently of the host hashing implementation. */
import type { UUID } from "../types/primitives.js";

export function validateUuid(value: unknown): UUID | null {
	return typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			value,
		)
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

function bytesToUuid(bytes: Uint8Array): string {
	const hex: string[] = [];
	for (let i = 0; i < bytes.length; i++) {
		const h = bytes[i].toString(16).padStart(2, "0");
		hex.push(h);
	}
	// Format: 8-4-4-4-12 hexadecimal digits
	return (
		hex.slice(0, 4).join("") +
		"-" +
		hex.slice(4, 6).join("") +
		"-" +
		hex.slice(6, 8).join("") +
		"-" +
		hex.slice(8, 10).join("") +
		"-" +
		hex.slice(10, 16).join("")
	);
}
