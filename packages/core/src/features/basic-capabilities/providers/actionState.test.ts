/**
 * Unit tests for the ACTION_STATE provider and truncateThought well-formed
 * Unicode truncation guarantees.
 */

import { describe, expect, it } from "vitest";
import { MAX_THOUGHT_CHARS, truncateThought } from "./actionState.ts";

function isWellFormed(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) {
				return false;
			}
			index += 1;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

describe("truncateThought well-formed Unicode boundaries", () => {
	it("keeps surrogate pairs intact at exact boundary", () => {
		const budget = MAX_THOUGHT_CHARS - 1;
		const text = `${"a".repeat(budget - 1)}🦊${"b".repeat(50)}`;
		const out = truncateThought(text);
		expect(out.length).toBeLessThanOrEqual(MAX_THOUGHT_CHARS);
		expect(isWellFormed(out)).toBe(true);
		expect(out.endsWith("…")).toBe(true);
		expect(out).not.toContain("\uD83E");
	});

	it("preserves fitting emoji under limit", () => {
		const text = `${"a".repeat(100)}🦊`;
		const out = truncateThought(text);
		expect(out).toBe(text);
		expect(isWellFormed(out)).toBe(true);
	});

	it("sanitizes lone surrogates before truncation", () => {
		const lone = `a\uD800${"b".repeat(3000)}`;
		const out = truncateThought(lone);
		expect(out).toContain("\uFFFD");
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBeLessThanOrEqual(MAX_THOUGHT_CHARS);
	});

	it("sanitizes lone surrogates without truncation when under limit", () => {
		const lone = `thought \uD800 test`;
		const out = truncateThought(lone);
		expect(out).toBe("thought \uFFFD test");
		expect(isWellFormed(out)).toBe(true);
	});
});
