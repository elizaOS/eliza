/**
 * Regression for evaluator service surrogate-safe truncation (500).
 */

import { describe, expect, it } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../utils/well-formed.ts";

const RAW_SECTION_LIMIT = 500;

function clampRawSection(rawSection: unknown): string {
	const text = typeof rawSection === "string" ? rawSection : JSON.stringify(rawSection) ?? "";
	const wellFormed = toWellFormedUnicode(text);
	return truncateWellFormed(wellFormed, RAW_SECTION_LIMIT);
}

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			i++;
		} else if (code >= 0xdc00 && code <= 0xdfff) return false;
	}
	return true;
}

describe("evaluator service well-formed", () => {
	it("backs off astral at 500 boundary (499+fox->499)", () => {
		const fox = "🦊";
		const input = `${"a".repeat(499)}${fox}${"b".repeat(20)}`;
		const out = clampRawSection(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(499);
		expect(out).toBe("a".repeat(499));
	});

	it("preserves fitting astral at 500 (498+fox intact)", () => {
		const fox = "🦊";
		const input = `${"a".repeat(498)}${fox}`;
		const out = clampRawSection(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out).toBe(input);
		expect(out.length).toBe(500);
	});

	it("sanitizes lone high surrogate", () => {
		const lone = `raw ${String.fromCharCode(0xd800)} section`;
		const out = clampRawSection(`${lone}${"x".repeat(600)}`);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("�")).toBe(true);
	});

	it("short passthrough", () => {
		const out = clampRawSection("short section");
		expect(out).toBe("short section");
		expect(isWellFormed(out)).toBe(true);
	});

	it("stringifies object then clamps well-formed", () => {
		const obj = { text: `a${"🦊".repeat(300)}` };
		const out = clampRawSection(obj);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBeLessThanOrEqual(500);
	});

	it("sweep around 500 well-formed", () => {
		const fox = "🦊";
		for (let n = 495; n <= 505; n++) {
			const input = `${"x".repeat(n)}${fox}${"y".repeat(20)}`;
			const out = clampRawSection(input);
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBeLessThanOrEqual(500);
		}
	});
});
