/**
 * Unit tests for the ACTION_STATE provider and complete thought normalization.
 * Unicode normalization guarantees.
 */

import { describe, expect, it } from "vitest";
import { normalizeThoughtText } from "./actionState.ts";

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

describe("normalizeThoughtText Unicode boundaries", () => {
	it("preserves long surrogate-pair text completely", () => {
		const text = `${"a".repeat(3_000)}🦊${"b".repeat(50)}`;
		const out = normalizeThoughtText(text);
		expect(out).toBe(text);
		expect(isWellFormed(out)).toBe(true);
	});

	it("preserves fitting emoji under limit", () => {
		const text = `${"a".repeat(100)}🦊`;
		const out = normalizeThoughtText(text);
		expect(out).toBe(text);
		expect(isWellFormed(out)).toBe(true);
	});

	it("sanitizes lone surrogates without shortening long text", () => {
		const lone = `a\uD800${"b".repeat(3000)}`;
		const out = normalizeThoughtText(lone);
		expect(out).toContain("\uFFFD");
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(lone.length);
	});

	it("sanitizes lone surrogates without truncation when under limit", () => {
		const lone = `thought \uD800 test`;
		const out = normalizeThoughtText(lone);
		expect(out).toBe("thought \uFFFD test");
		expect(isWellFormed(out)).toBe(true);
	});
});
