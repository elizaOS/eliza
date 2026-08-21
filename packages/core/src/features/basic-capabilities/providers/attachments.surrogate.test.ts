/** Surrogate safety for formatAttachmentUrlForPrompt: URL truncation must never emit lone surrogates. */
import { describe, expect, test } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../../../utils/well-formed.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return toWellFormedUnicode(value) === value;
}

function formatAttachmentUrlForPrompt(url: string | undefined): string {
	if (!url) return "(none)";
	if (url.startsWith("data:")) {
		const mime = /^data:([^;,]+)/.exec(url)?.[1] ?? "binary";
		return `[inline ${mime} data, ${url.length} chars]`;
	}
	return url.length > 512
		? `${truncateWellFormed(toWellFormedUnicode(url), 511)}…`
		: toWellFormedUnicode(url);
}

describe("formatAttachmentUrlForPrompt surrogate safety", () => {
	test("emoji at 510 boundary backs off without lone surrogate", () => {
		// "https://example.com/" is 20 chars; 20 + 490 = 510 chars before fox
		// Fox at 510..512 exceeds 511 budget, so it backs off to 510
		const input = `https://example.com/${"a".repeat(490)}🦊${"b".repeat(50)}`;
		const out = formatAttachmentUrlForPrompt(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBeLessThanOrEqual(512);
		expect(() => JSON.stringify({ url: out })).not.toThrow();
		expect(out.endsWith("…")).toBe(true);
		expect(out.includes("🦊")).toBe(false);
	});

	test("fitting emoji ending at 511 kept intact before ellipsis", () => {
		// 20 + 489 = 509 chars before fox; fox at 509..511 fits within 511
		const input = `https://example.com/${"a".repeat(489)}🦊${"b".repeat(50)}`;
		const out = formatAttachmentUrlForPrompt(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(512);
		expect(out.endsWith("🦊…")).toBe(true);
	});

	test("short URL with emoji passes through untouched", () => {
		const input = "https://example.com/item/🦊-fox.png";
		const out = formatAttachmentUrlForPrompt(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out).toBe(input);
	});

	test("data URL passes through compact descriptor", () => {
		const input = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA";
		const out = formatAttachmentUrlForPrompt(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out).toBe(`[inline image/png data, ${input.length} chars]`);
	});

	test("lone high surrogate is sanitized before truncation", () => {
		const input = `https://example.com/\ud800/${"x".repeat(600)}`;
		const out = formatAttachmentUrlForPrompt(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("\ud800")).toBe(false);
		expect(out.length).toBeLessThanOrEqual(512);
	});

	test("sweep 505..515 emoji offsets all stay well-formed and within 512 chars", () => {
		const fox = "🦊";
		for (let n = 505; n <= 515; n++) {
			const input = `${"a".repeat(n)}${fox}${"b".repeat(50)}`;
			const out = formatAttachmentUrlForPrompt(input);
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBeLessThanOrEqual(512);
			expect(() => JSON.stringify({ url: out })).not.toThrow();
		}
	});
});
