/**
 * Checks the context-hash helpers: deterministic key-ordered JSON
 * serialization, order-independent segment hashing, and cumulative
 * order-sensitive prefix hashes that back the prompt-cache prefix keys. Pure
 * functions, no model.
 */
import { describe, expect, it } from "vitest";
import {
	computePrefixHashes,
	hashPromptSegment,
	stableJsonStringify,
} from "../context-hash";

describe("context hash helpers", () => {
	it("serializes JSON with deterministic key ordering", () => {
		expect(stableJsonStringify({ b: 2, a: { d: 4, c: 3 } })).toBe(
			'{"a":{"c":3,"d":4},"b":2}',
		);
		expect(stableJsonStringify({ z: undefined, a: [2, undefined, 1] })).toBe(
			'{"a":[2,null,1]}',
		);
	});

	it("produces the same segment hash for equivalent ordered JSON", () => {
		const left = hashPromptSegment({
			content: "stable instructions",
			stable: true,
			metadata: { b: 2, a: 1 },
		});
		const right = hashPromptSegment({
			content: "stable instructions",
			stable: true,
			metadata: { a: 1, b: 2 },
		});

		expect(left.hash).toBe(right.hash);
		expect(left.contentHash).toBe(right.contentHash);
	});

	it("computes cumulative prefix hashes that depend on segment order", () => {
		const first = computePrefixHashes([
			{ content: "alpha", stable: true },
			{ content: "beta", stable: false },
		]);
		const same = computePrefixHashes([
			{ content: "alpha", stable: true },
			{ content: "beta", stable: false },
		]);
		const reordered = computePrefixHashes([
			{ content: "beta", stable: false },
			{ content: "alpha", stable: true },
		]);

		expect(first).toEqual(same);
		expect(first[1]?.hash).not.toBe(reordered[1]?.hash);
		expect(first[0]?.segmentHash).not.toBe(first[1]?.segmentHash);
	});
});

describe("locale independence", () => {
	// The prompt cache and trajectory prefix matching rely on the same context
	// hashing identically on every host. ICU collation is locale-dependent, so
	// sorting keys with localeCompare made the serialized bytes — and every
	// hash derived from them — vary with the machine's locale.
	it("orders keys by UTF-16 code units, not host collation", () => {
		expect(stableJsonStringify({ z: 1, ä: 2, B: 3, a: 4 })).toBe(
			'{"B":3,"a":4,"z":1,"ä":2}',
		);
	});

	it("hashes identically to an explicitly code-unit-ordered object", () => {
		expect(stableJsonStringify({ z: 1, ä: 2, B: 3, a: 4 })).toBe(
			stableJsonStringify({ B: 3, a: 4, z: 1, ä: 2 }),
		);
	});
});
