/** Surrogate safety for planner-loop rescue prompt excerpts. */
import { describe, expect, test } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../utils/well-formed.ts";

const RESCUE_EXCERPT_MAX_CHARS = 12_000;

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return true;
}

function buildRescueExcerptMock(name: string, text: string): string {
	return [
		`<tool_result name="${name}">`,
		truncateWellFormed(toWellFormedUnicode(text), RESCUE_EXCERPT_MAX_CHARS),
		"</tool_result>",
	].join("\n");
}

describe("planner-loop rescue excerpt surrogate safety", () => {
	test("emoji at 11999 boundary backs off cleanly without lone surrogate", () => {
		const fox = "🦊";
		const input = `${"a".repeat(11999)}${fox}${"b".repeat(1000)}`;
		const excerpt = buildRescueExcerptMock("search_web", input);
		expect(isWellFormed(excerpt)).toBe(true);
		expect(() => JSON.stringify({ excerpt })).not.toThrow();
	});

	test("fitting emoji ending at 12000 kept intact", () => {
		const fox = "🦊";
		const input = `${"a".repeat(11998)}${fox}`;
		const excerpt = buildRescueExcerptMock("fetch_page", input);
		expect(isWellFormed(excerpt)).toBe(true);
		expect(excerpt.includes(fox)).toBe(true);
	});

	test("short tool result with emoji passes through untouched", () => {
		const input = "Found documentation with 🦊 search results";
		const excerpt = buildRescueExcerptMock("read_docs", input);
		expect(isWellFormed(excerpt)).toBe(true);
		expect(excerpt.includes(input)).toBe(true);
	});

	test("lone high surrogate in tool output is sanitized safely", () => {
		const badInput = `bad \ud800 in tool result ${"x".repeat(15000)}`;
		const excerpt = buildRescueExcerptMock("run_cli", badInput);
		expect(isWellFormed(excerpt)).toBe(true);
		expect(excerpt.includes("\ud800")).toBe(false);
	});

	test("sweep offsets around 12KB cap all stay well-formed", () => {
		const fox = "🦊";
		for (let offset = -5; offset <= 5; offset++) {
			const n = RESCUE_EXCERPT_MAX_CHARS + offset;
			const input = `${"a".repeat(n)}${fox}${"b".repeat(500)}`;
			const excerpt = buildRescueExcerptMock("test_tool", input);
			expect(isWellFormed(excerpt)).toBe(true);
			expect(() => JSON.stringify({ excerpt })).not.toThrow();
		}
	});
});
