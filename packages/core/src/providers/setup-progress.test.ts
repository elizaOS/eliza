/**
 * Tests for setup-progress provider and lossless Unicode normalization.
 */

import { describe, expect, it } from "vitest";
import { normalizeSetupProgressText } from "./setup-progress";

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

describe("normalizeSetupProgressText Unicode boundaries", () => {
	it("preserves long surrogate-pair progress text completely", () => {
		const text = `${"a".repeat(6_000)}🦊${"b".repeat(50)}`;
		const out = normalizeSetupProgressText(text);
		expect(out).toBe(text);
		expect(isWellFormed(out)).toBe(true);
	});

	it("preserves fitting emoji without truncation", () => {
		const text = `${"a".repeat(100)}🦊`;
		const out = normalizeSetupProgressText(text);
		expect(out).toBe(text);
		expect(isWellFormed(out)).toBe(true);
	});

	it("sanitizes lone surrogates without shortening long text", () => {
		const lone = `setup \uD800 ${"b".repeat(6000)}`;
		const out = normalizeSetupProgressText(lone);
		expect(out).toContain("\uFFFD");
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(lone.length);
	});

	it("sanitizes lone surrogates without truncation when fitting under limit", () => {
		const lone = "setup progress \uD800 current";
		const out = normalizeSetupProgressText(lone);
		expect(out).toBe("setup progress \uFFFD current");
		expect(isWellFormed(out)).toBe(true);
	});
});
