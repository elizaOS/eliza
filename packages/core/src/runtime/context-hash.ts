/**
 * Deterministic hashing for prompt segments and their cumulative prefixes.
 * Provides a key-sorted, undefined-dropping stable JSON serializer plus sha256
 * helpers so identical context prefixes hash identically across runs — the basis
 * for prompt-cache reuse and trajectory prefix matching.
 */
import { createHash } from "../utils/crypto-compat";

type StableJsonValue =
	| string
	| number
	| boolean
	| null
	| readonly StableJsonValue[]
	| { readonly [key: string]: StableJsonValue | undefined };

interface HashablePromptSegment {
	content: string;
	stable?: boolean;
	id?: string;
	label?: string;
	metadata?: StableJsonValue;
}

interface PrefixHash {
	index: number;
	hash: string;
	segmentHash: string;
}

export function hashString(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function stableStringifyValue(value: unknown, seen: WeakSet<object>): string {
	if (value === null) {
		return "null";
	}

	const type = typeof value;
	if (type === "string" || type === "number" || type === "boolean") {
		return JSON.stringify(value);
	}

	if (type === "bigint") {
		throw new TypeError("Cannot stable stringify BigInt values as JSON");
	}

	if (type === "undefined" || type === "function" || type === "symbol") {
		return "";
	}

	if (Array.isArray(value)) {
		if (seen.has(value)) {
			throw new TypeError("Cannot stable stringify circular structures");
		}
		seen.add(value);
		const serialized = `[${value
			.map((item) => {
				const serialized = stableStringifyValue(item, seen);
				return serialized === "" ? "null" : serialized;
			})
			.join(",")}]`;
		seen.delete(value);
		return serialized;
	}

	if (seen.has(value as object)) {
		throw new TypeError("Cannot stable stringify circular structures");
	}
	seen.add(value as object);
	const record = value as Record<string, unknown>;
	// Code-unit order, not localeCompare: ICU collation depends on the host
	// locale, so the same object would hash differently under LC_ALL=sv_SE than
	// under LC_ALL=C — defeating the cross-run identity this module exists to
	// provide.
	const keys = Object.keys(record).sort((left, right) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
	let serialized = "";
	for (const key of keys) {
		const entry = stableStringifyValue(record[key], seen);
		// Undefined, function and symbol members are dropped, as in JSON.
		if (entry === "") continue;
		serialized += `${serialized ? "," : ""}${JSON.stringify(key)}:${entry}`;
	}
	seen.delete(value as object);
	return `{${serialized}}`;
}

export function stableJsonStringify(value: unknown): string {
	const serialized = stableStringifyValue(value, new WeakSet());
	return serialized === "" ? "null" : serialized;
}

export function hashStableJson(value: unknown): string {
	return hashString(stableJsonStringify(value));
}

export function computePrefixHashes(
	segments: readonly HashablePromptSegment[],
): PrefixHash[] {
	let prefixHash = hashStableJson({ contextPrefix: [] });
	return segments.map((segment, index) => {
		const segmentHash = hashStableJson({
			content: segment.content,
			id: segment.id,
			label: segment.label,
			metadata: segment.metadata,
			stable: Boolean(segment.stable),
		});
		prefixHash = hashStableJson({
			previousPrefixHash: prefixHash,
			segmentHash,
		});
		return { index, hash: prefixHash, segmentHash };
	});
}
