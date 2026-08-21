/**
 * Regression for facts provider turn evidence surrogate safety.
 */

import { describe, expect, it } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../../../utils/well-formed.ts";

const EVIDENCE_TEXT_CHAR_CAP = 4_000;

function capTurnEvidence(parts: string[]): string {
	const joined = parts.filter((part) => part.trim().length > 0).join("\n");
	const wellFormed = toWellFormedUnicode(joined);
	return wellFormed.length > EVIDENCE_TEXT_CHAR_CAP
		? truncateWellFormed(wellFormed, EVIDENCE_TEXT_CHAR_CAP)
		: wellFormed;
}

function isWellFormed(v: string): boolean {
	if (!v) return true;
	if (
		typeof (v as unknown as { isWellFormed?: () => boolean }).isWellFormed ===
		"function"
	)
		return (v as unknown as { isWellFormed: () => boolean }).isWellFormed();
	for (let i = 0; i < v.length; i++) {
		const c = v.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff) {
			const n = v.charCodeAt(i + 1);
			if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
			i++;
		} else if (c >= 0xdc00 && c <= 0xdfff) return false;
	}
	return true;
}

describe("facts provider turn evidence surrogate safety", () => {
	it("keeps surrogate pairs intact at 4,000-char boundary", () => {
		const fox = String.fromCharCode(0xd83e, 0xdd8a);
		const parts = [`${"a".repeat(3999)}${fox}${"b".repeat(100)}`];
		const out = capTurnEvidence(parts);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(3999);
		expect(out).not.toContain("\uD83E");
	});

	it("sanitizes lone surrogate in evidence fragments", () => {
		const parts = [
			`Evidence chunk ${String.fromCharCode(0xd800)} test ${"x".repeat(5000)}`,
		];
		const out = capTurnEvidence(parts);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("\uFFFD")).toBe(true);
		expect(out.length).toBeLessThanOrEqual(EVIDENCE_TEXT_CHAR_CAP);
	});
});
