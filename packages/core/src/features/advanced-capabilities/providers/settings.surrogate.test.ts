/**
 * Regression for settings provider surrogate-safe truncation (12000).
 */

import { describe, expect, it } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../../../utils/well-formed.ts";

const MAX_SETTINGS_OUTPUT_LENGTH = 12000;

function clampSettingsOutput(output: string): string {
	const wellFormed = toWellFormedUnicode(output);
	return wellFormed.length > MAX_SETTINGS_OUTPUT_LENGTH
		? `${truncateWellFormed(wellFormed, MAX_SETTINGS_OUTPUT_LENGTH - 3)}...`
		: wellFormed;
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

describe("settings provider well-formed", () => {
	it("keeps surrogate intact at 12000 boundary", () => {
		const emoji = String.fromCharCode(0xd83d, 0xde00);
		const input = `${"a".repeat(11999)}${emoji}${"b".repeat(20)}`;
		const out = clampSettingsOutput(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBeLessThanOrEqual(12000);
		expect(out.endsWith("...")).toBe(true);
	});

	it("preserves fitting emoji", () => {
		const emoji = String.fromCharCode(0xd83d, 0xde00);
		const input = `${"a".repeat(11997)}${emoji}`;
		// 11997 +2 =11999 <12000 so no truncation
		const out = clampSettingsOutput(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes(emoji)).toBe(true);
	});

	it("sanitizes lone surrogate", () => {
		const lone = `setting ${String.fromCharCode(0xd800)} value`;
		const out = clampSettingsOutput(`${lone}${"x".repeat(13000)}`);
		expect(isWellFormed(out)).toBe(true);
	});

	it("short passthrough", () => {
		const out = clampSettingsOutput("short settings output");
		expect(out).toBe("short settings output");
	});

	it("sweep around 12000 well-formed", () => {
		const emoji = String.fromCharCode(0xd83e, 0xdd8a);
		for (let n = 11995; n <= 12005; n++) {
			const input = `${"x".repeat(n)}${emoji}${"y".repeat(20)}`;
			const out = clampSettingsOutput(input);
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBeLessThanOrEqual(12000);
		}
	});
});
