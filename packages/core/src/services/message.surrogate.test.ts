/**
 * Regression for message `cleanPriorDialogueSpeakerName` surrogate-safe
 * normalization. The speaker name is prefixed onto prior-dialogue lines that go
 * into the prompt, so CLAUDE.md's prompt-integrity rule forbids capping it: the
 * helper only trims, collapses whitespace, and repairs lone surrogates. These
 * cases pin that a long or emoji-bearing name survives complete and well-formed.
 */

import { describe, expect, it } from "vitest";
import { cleanPriorDialogueSpeakerName } from "./message.ts";

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

describe("cleanPriorDialogueSpeakerName well-formed", () => {
	it("keeps a long emoji-bearing name complete and well-formed", () => {
		const emoji = String.fromCharCode(0xd83d, 0xde00);
		const input = `${"a".repeat(76)}${emoji}${"b".repeat(20)}`;
		const out = cleanPriorDialogueSpeakerName(input) ?? "";
		expect(isWellFormed(out)).toBe(true);
		// No cap and no ellipsis: the name reaches the prompt intact.
		expect(out).toBe(input);
		expect(out.endsWith("...")).toBe(false);
	});

	it("preserves a well-formed emoji name of exactly 80 units", () => {
		const emoji = String.fromCharCode(0xd83d, 0xde00);
		const input = `${"a".repeat(78)}${emoji}`;
		const out = cleanPriorDialogueSpeakerName(input) ?? "";
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(80);
		expect(out.includes(emoji)).toBe(true);
	});

	it("sanitizes lone high surrogate", () => {
		const lone = `speaker ${String.fromCharCode(0xd800)} name`;
		const out = cleanPriorDialogueSpeakerName(lone) ?? "";
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("�")).toBe(true);
	});

	it("short names unchanged and well-formed", () => {
		const out = cleanPriorDialogueSpeakerName("Alice") ?? "";
		expect(out).toBe("Alice");
		expect(isWellFormed(out)).toBe(true);
	});

	it("sweep around 80 stays complete and well-formed", () => {
		const emoji = String.fromCharCode(0xd83e, 0xdd8a);
		for (let n = 75; n <= 85; n++) {
			const input = `${"x".repeat(n)}${emoji}${"y".repeat(20)}`;
			const out = cleanPriorDialogueSpeakerName(input) ?? "";
			expect(isWellFormed(out)).toBe(true);
			expect(out).toBe(input);
		}
	});

	it("trims and normalizes whitespace before truncation", () => {
		const out = cleanPriorDialogueSpeakerName("  Alice   Bob  ") ?? "";
		expect(out).toBe("Alice Bob");
	});

	it("returns undefined for non-string", () => {
		expect(cleanPriorDialogueSpeakerName(undefined)).toBeUndefined();
		expect(
			cleanPriorDialogueSpeakerName(123 as unknown as string),
		).toBeUndefined();
	});
});
