/**
 * Tests for setup-progress provider and surrogate-safe truncateSetupProgressText helper.
 */

import { describe, expect, it } from "vitest";
import {
	MAX_SETUP_OUTPUT_LENGTH,
	truncateSetupProgressText,
} from "./setup-progress";

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

describe("truncateSetupProgressText well-formed Unicode boundaries", () => {
	it("keeps surrogate pairs intact when truncating progress text at boundary", () => {
		const budget = MAX_SETUP_OUTPUT_LENGTH - 3;
		const text = `${"a".repeat(budget - 1)}🦊${"b".repeat(50)}`;
		const out = truncateSetupProgressText(text);
		expect(out.length).toBeLessThanOrEqual(MAX_SETUP_OUTPUT_LENGTH);
		expect(isWellFormed(out)).toBe(true);
		expect(out.endsWith("...")).toBe(true);
		expect(out).not.toContain("\uD83E");
	});

	it("preserves fitting emoji without truncation", () => {
		const text = `${"a".repeat(100)}🦊`;
		const out = truncateSetupProgressText(text);
		expect(out).toBe(text);
		expect(isWellFormed(out)).toBe(true);
	});

	it("sanitizes lone surrogates before truncation", () => {
		const lone = `setup \uD800 ${"b".repeat(6000)}`;
		const out = truncateSetupProgressText(lone);
		expect(out).toContain("\uFFFD");
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBeLessThanOrEqual(MAX_SETUP_OUTPUT_LENGTH);
	});

	it("sanitizes lone surrogates without truncation when fitting under limit", () => {
		const lone = "setup progress \uD800 current";
		const out = truncateSetupProgressText(lone);
		expect(out).toBe("setup progress \uFFFD current");
		expect(isWellFormed(out)).toBe(true);
	});
});
