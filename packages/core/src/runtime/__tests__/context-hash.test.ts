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
