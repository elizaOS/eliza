/**
 * Regression for outbound envelope guard surrogate safety (400).
 */

import { describe, expect, it } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../utils/well-formed.ts";

const REPORT_PREVIEW_CHARS = 400;

function preview(text: string): string {
	return truncateWellFormed(toWellFormedUnicode(text), REPORT_PREVIEW_CHARS);
}

function isWellFormed(value: string): boolean {
	if (!value) return true;
	if (
		typeof (value as unknown as { isWellFormed?: () => boolean })
			.isWellFormed === "function"
	)
		return (value as unknown as { isWellFormed: () => boolean }).isWellFormed();
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

describe("outbound-envelope-guard well-formed", () => {
	it("keeps surrogate intact at 400 boundary", () => {
		const emoji = String.fromCharCode(0xd83d, 0xde00);
		const input = `${"a".repeat(399)}${emoji}${"b".repeat(20)}`;
		const out = preview(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBeLessThanOrEqual(400);
	});

	it("preserves fitting emoji", () => {
		const emoji = String.fromCharCode(0xd83d, 0xde00);
		const input = `${"a".repeat(398)}${emoji}`;
		const out = preview(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes(emoji)).toBe(true);
	});

	it("sanitizes lone surrogate", () => {
		const lone = `blocked ${String.fromCharCode(0xd800)} text`;
		const out = preview(`${lone}${"x".repeat(500)}`);
		expect(isWellFormed(out)).toBe(true);
	});

	it("short passthrough", () => {
		expect(preview("short")).toBe("short");
	});

	it("sweep around 400 well-formed", () => {
		const emoji = String.fromCharCode(0xd83e, 0xdd8a);
		for (let n = 395; n <= 405; n++) {
			const input = `${"x".repeat(n)}${emoji}${"y".repeat(20)}`;
			const out = preview(input);
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBeLessThanOrEqual(400);
		}
	});
});
