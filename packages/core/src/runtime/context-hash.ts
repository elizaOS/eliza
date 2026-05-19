import { createHash } from "../utils/crypto-compat";

export type StableJsonValue =
	| string
	| number
	| boolean
	| null
	| readonly StableJsonValue[]
	| { readonly [key: string]: StableJsonValue | undefined };

export interface HashablePromptSegment {
	content: string;
	stable?: boolean;
	id?: string;
	label?: string;
	metadata?: StableJsonValue;
}

export interface SegmentHash {
	index: number;
	hash: string;
	contentHash: string;
	stable: boolean;
}

export interface PrefixHash {
	index: number;
	hash: string;
	segmentHash: string;
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
}

export function hashString(value: string): string {
	return toHex(createHash("sha256").update(value).digest());
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

	if (type === "object") {
		if (seen.has(value as object)) {
			throw new TypeError("Cannot stable stringify circular structures");
		}
		seen.add(value as object);
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entryValue]) => {
				const entryType = typeof entryValue;
				return (
					entryType !== "undefined" &&
					entryType !== "function" &&
					entryType !== "symbol"
				);
			})
			.sort(([left], [right]) => left.localeCompare(right))
			.map(
				([key, entryValue]) =>
					`${JSON.stringify(key)}:${stableStringifyValue(entryValue, seen)}`,
			);
		seen.delete(value as object);
		return `{${entries.join(",")}}`;
	}

	return JSON.stringify(value);
}

export function stableJsonStringify(value: unknown): string {
	const serialized = stableStringifyValue(value, new WeakSet());
	return serialized === "" ? "null" : serialized;
}

export function hashStableJson(value: unknown): string {
	return hashString(stableJsonStringify(value));
}

export function hashPromptSegment(segment: HashablePromptSegment): SegmentHash {
	return {
		index: -1,
		hash: hashStableJson({
			content: segment.content,
			id: segment.id,
			label: segment.label,
			metadata: segment.metadata,
			stable: Boolean(segment.stable),
		}),
		contentHash: hashString(segment.content),
		stable: Boolean(segment.stable),
	};
}

export function hashPromptSegments(
	segments: readonly HashablePromptSegment[],
): SegmentHash[] {
	return segments.map((segment, index) => ({
		...hashPromptSegment(segment),
		index,
	}));
}

export function computePrefixHashes(
	segments: readonly HashablePromptSegment[],
): PrefixHash[] {
	let prefixHash = hashStableJson({ contextPrefix: [] });
	return hashPromptSegments(segments).map((segmentHash, index) => {
		prefixHash = hashStableJson({
			previousPrefixHash: prefixHash,
			segmentHash: segmentHash.hash,
		});
		return {
			index,
			hash: prefixHash,
			segmentHash: segmentHash.hash,
		};
	});
}
