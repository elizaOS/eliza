/** Surrogate safety for trajectory recorder string truncation: must never emit lone surrogates. */
import { describe, expect, test } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../utils/well-formed.ts";

const RECORD_SANITIZE_MAX_STRING_CHARS = 64 * 1024;
const RECORD_SANITIZE_TRUNCATION_SUFFIX = "...[truncated]";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return toWellFormedUnicode(value) === value;
}

function truncateRecordStringMock(value: string): string {
	const wellFormed = toWellFormedUnicode(value);
	if (wellFormed.length <= RECORD_SANITIZE_MAX_STRING_CHARS) return wellFormed;
	const previewLength = Math.max(
		0,
		RECORD_SANITIZE_MAX_STRING_CHARS - RECORD_SANITIZE_TRUNCATION_SUFFIX.length,
	);
	return `${truncateWellFormed(wellFormed, previewLength)}${RECORD_SANITIZE_TRUNCATION_SUFFIX}`;
}

describe("trajectory recorder string surrogate safety", () => {
	const targetPreview =
		RECORD_SANITIZE_MAX_STRING_CHARS - RECORD_SANITIZE_TRUNCATION_SUFFIX.length;

	test("emoji at preview boundary backs off without lone surrogate", () => {
		const input = `${"a".repeat(targetPreview - 1)}🦊${"b".repeat(1000)}`;
		const out = truncateRecordStringMock(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.endsWith(RECORD_SANITIZE_TRUNCATION_SUFFIX)).toBe(true);
		expect(out.length).toBe(
			targetPreview - 1 + RECORD_SANITIZE_TRUNCATION_SUFFIX.length,
		);
		expect(() => JSON.stringify({ record: out })).not.toThrow();
	});

	test("fitting emoji ending at preview boundary kept intact", () => {
		const input = `${"a".repeat(targetPreview - 2)}🦊${"b".repeat(1000)}`;
		const out = truncateRecordStringMock(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.endsWith(RECORD_SANITIZE_TRUNCATION_SUFFIX)).toBe(true);
		expect(out.length).toBe(
			targetPreview + RECORD_SANITIZE_TRUNCATION_SUFFIX.length,
		);
	});

	test("short record string with emoji passes through untouched", () => {
		const input = "Step execution log with fox 🦊 emoji";
		const out = truncateRecordStringMock(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out).toBe(input);
	});

	test("lone high surrogate is sanitized before truncation", () => {
		const input = `bad \ud800 surrogate ${"x".repeat(70000)}`;
		const out = truncateRecordStringMock(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("\ud800")).toBe(false);
		expect(out.endsWith(RECORD_SANITIZE_TRUNCATION_SUFFIX)).toBe(true);
	});

	test("sweep offsets around 64KB cap all stay well-formed", () => {
		const fox = "🦊";
		for (let offset = -5; offset <= 5; offset++) {
			const n = targetPreview + offset;
			const input = `${"a".repeat(n)}${fox}${"b".repeat(1000)}`;
			const out = truncateRecordStringMock(input);
			expect(isWellFormed(out)).toBe(true);
			expect(() => JSON.stringify({ record: out })).not.toThrow();
		}
	});
});
