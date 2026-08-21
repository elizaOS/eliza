/**
 * Regression for MESSAGE and POST content shaping truncation surrogate safety.
 */

import { describe, expect, it } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../../../utils/well-formed.ts";

function shapeContentText(
	rawText: string,
	maxLength: number,
	postProcess?: (s: string) => string,
): string {
	let text = typeof rawText === "string" ? toWellFormedUnicode(rawText) : "";
	if (text && typeof postProcess === "function") {
		text = toWellFormedUnicode(postProcess(text));
	}
	if (
		text &&
		typeof maxLength === "number" &&
		Number.isFinite(maxLength) &&
		maxLength > 0 &&
		text.length > maxLength
	) {
		text = truncateWellFormed(text, Math.max(0, Math.floor(maxLength)));
	}
	return text;
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

describe("MESSAGE and POST content shaping surrogate safety", () => {
	it("keeps surrogate pair intact at 280-char Twitter limit", () => {
		const limit = 280;
		const fox = String.fromCharCode(0xd83e, 0xdd8a);
		const input = `${"a".repeat(279)}${fox}${"b".repeat(50)}`;
		const out = shapeContentText(input, limit);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(279);
	});

	it("keeps surrogate pair intact at 2000-char Discord limit", () => {
		const limit = 2000;
		const fox = String.fromCharCode(0xd83e, 0xdd8a);
		const input = `${"a".repeat(1999)}${fox}${"b".repeat(50)}`;
		const out = shapeContentText(input, limit);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(1999);
	});

	it("preserves fitting emoji under limit", () => {
		const limit = 280;
		const fox = String.fromCharCode(0xd83e, 0xdd8a);
		const input = `Hello world ${fox}!`;
		const out = shapeContentText(input, limit);
		expect(isWellFormed(out)).toBe(true);
		expect(out).toBe(input);
	});

	it("sanitizes lone surrogate in message content before truncation", () => {
		const limit = 100;
		const lone = `msg ${String.fromCharCode(0xd800)} ${"a".repeat(200)}`;
		const out = shapeContentText(lone, limit);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("\uFFFD")).toBe(true);
		expect(out.length).toBeLessThanOrEqual(limit);
	});
});
