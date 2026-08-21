/**
 * Regression for documents `generateContentBasedId` surrogate-safe
 * truncation (2000 cap). Mirrors #23581 precedent.
 */

import { describe, expect, it } from "vitest";
import { toWellFormedUnicode } from "../../utils/well-formed.ts";
import { generateContentBasedId } from "./utils.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	if (
		typeof (value as unknown as { isWellFormed?: () => boolean })
			.isWellFormed === "function"
	) {
		return (value as unknown as { isWellFormed: () => boolean }).isWellFormed();
	}
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff) {
			const n = value.charCodeAt(i + 1);
			if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
			i++;
		} else if (c >= 0xdc00 && c <= 0xdfff) return false;
	}
	return true;
}

describe("generateContentBasedId well-formed", () => {
	it("keeps surrogate pairs intact at 2000 boundary (plain)", () => {
		const emoji = String.fromCharCode(0xd83d, 0xde00);
		const content = `${"a".repeat(1999)}${emoji}${"b".repeat(20)}`;
		const id = generateContentBasedId(content, "agent-1", { maxChars: 2000 });
		const id2 = generateContentBasedId(
			`${"a".repeat(1999)}${emoji}X`,
			"agent-1",
			{ maxChars: 2000 },
		);
		expect(id).toBe(id2);
	});

	it("preserves fitting emoji under cap", () => {
		const emoji = String.fromCharCode(0xd83d, 0xde00);
		const content = `${"a".repeat(1998)}${emoji}`;
		const id = generateContentBasedId(content, "agent-1", { maxChars: 2000 });
		const id2 = generateContentBasedId(content, "agent-1", { maxChars: 2000 });
		expect(id).toBe(id2);
		expect(isWellFormed(toWellFormedUnicode(content).slice(0, 2000))).toBe(
			true,
		);
	});

	it("sanitizes lone high surrogate before hashing", () => {
		const lone = `doc ${String.fromCharCode(0xd800)} content`;
		const id = generateContentBasedId(lone, "agent-1", { maxChars: 2000 });
		expect(isWellFormed(toWellFormedUnicode(lone))).toBe(true);
		expect(id).toBeTruthy();
	});

	it("handles base64 path with emoji", () => {
		const emoji = String.fromCharCode(0xd83e, 0xdd8a);
		const raw = `${"a".repeat(1999)}${emoji}${"b".repeat(20)}`;
		const base64 = Buffer.from(raw).toString("base64");
		const id = generateContentBasedId(base64, "agent-1", { maxChars: 2000 });
		const id2 = generateContentBasedId(base64, "agent-1", { maxChars: 2000 });
		expect(id).toBe(id2);
	});

	it("never splits at sweep around 2000", () => {
		for (let n = 1995; n <= 2005; n++) {
			const emoji = String.fromCharCode(0xd83e, 0xdd8a);
			const content = `${"x".repeat(n)}${emoji}${"y".repeat(20)}`;
			const wellFormed = toWellFormedUnicode(content);
			expect(isWellFormed(wellFormed)).toBe(true);
		}
	});
});
