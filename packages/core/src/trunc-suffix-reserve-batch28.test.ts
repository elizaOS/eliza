/**
 * Pins trunc suffix reserve batch 28 (systematic overflow by suffix length "..." =3):
 * - runtime.ts:9225 `slice(0, 500)}...` (500+3=503) → `500-3 (497)` bounded to 500
 * - setup-progress.ts:244 `slice(0, MAX_SETUP_OUTPUT_LENGTH)}...` (5000+3=5003) → `5000-3`
 * - settings.ts:396 `slice(0, MAX_SETTINGS_OUTPUT_LENGTH)}...` (12000+3=12003) → `12000-3`
 * - context-summary.ts:80 `slice(0, MAX_SUMMARY_TEXT_LENGTH)}...` (3000+3=3003) → `3000-3`
 * - long-term-memory.ts:96 `slice(0, MAX_LONG_TERM_MEMORY_TEXT_LENGTH)}...` (3000+3=3003) → `3000-3`
 * Sibling correct: deterministic-model-plugin.ts:507 `slice(0,497)...` (500-3), executor.ts:425 `slice(0, maxLength-3)...`, awareness/registry.ts:83 `SUMMARY_CHAR_LIMIT-3`, etc.
 */

import { describe, expect, it } from "vitest";

function oldTrunc(text: string, max: number) {
	return text.length > max ? `${text.slice(0, max)}...` : text;
}
function fixedTrunc(text: string, max: number) {
	return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

describe("trunc suffix reserve batch 28 — 5 sites (... suffix 3)", () => {
	it("old 500+3 vs fixed 500", () => {
		const max = 500;
		const text = "a".repeat(600);
		const old = oldTrunc(text, max);
		const fixed = fixedTrunc(text, max);
		expect(old.length).toBe(503);
		expect(fixed.length).toBe(500);
		expect(fixed).toBe("a".repeat(497) + "...");
	});

	it("old 5000+3 vs fixed 5000", () => {
		const max = 5000;
		const text = "b".repeat(6000);
		const old = oldTrunc(text, max);
		const fixed = fixedTrunc(text, max);
		expect(old.length).toBe(5003);
		expect(fixed.length).toBe(5000);
	});

	it("old 12000+3 vs fixed 12000", () => {
		const max = 12000;
		const text = "c".repeat(13000);
		const old = oldTrunc(text, max);
		const fixed = fixedTrunc(text, max);
		expect(old.length).toBe(12003);
		expect(fixed.length).toBe(12000);
	});

	it("old 3000+3 vs fixed 3000 (context + long-term)", () => {
		const max = 3000;
		const text = "d".repeat(4000);
		const old = oldTrunc(text, max);
		const fixed = fixedTrunc(text, max);
		expect(old.length).toBe(3003);
		expect(fixed.length).toBe(3000);
	});

	it(" sibling proof: files reserve suffix length -3", async () => {
		const fs = await import("node:fs");
		const path = await import("node:path");
		const repoRoot = fs.existsSync("packages/core/src/runtime.ts")
			? "."
			: fs.existsSync("../../packages/core/src/runtime.ts")
				? "../.."
				: "/tmp/eliza-verify2";
		const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), "utf8");
		expect(read("packages/core/src/runtime.ts")).toContain("500 - 3");
		expect(read("packages/core/src/providers/setup-progress.ts")).toContain(
			"MAX_SETUP_OUTPUT_LENGTH - 3",
		);
		expect(
			read(
				"packages/core/src/features/advanced-capabilities/providers/settings.ts",
			),
		).toContain("MAX_SETTINGS_OUTPUT_LENGTH - 3");
		expect(
			read(
				"packages/core/src/features/advanced-memory/providers/context-summary.ts",
			),
		).toContain("MAX_SUMMARY_TEXT_LENGTH - 3");
		expect(
			read(
				"packages/core/src/features/advanced-memory/providers/long-term-memory.ts",
			),
		).toContain("MAX_LONG_TERM_MEMORY_TEXT_LENGTH - 3");
		// sibling correct still present
		expect(
			read("packages/core/src/testing/deterministic-model-plugin.ts"),
		).toContain("497");
		expect(read("packages/scenario-runner/src/executor.ts")).toContain(
			"maxLength - 3",
		);
		expect(read("packages/shared/src/awareness/registry.ts")).toContain(
			"SUMMARY_CHAR_LIMIT - 3",
		);
		// ensure old patterns gone
		expect(read("packages/core/src/runtime.ts")).not.toContain(
			"slice(0, 500)}...`",
		);
		expect(read("packages/core/src/providers/setup-progress.ts")).not.toContain(
			"MAX_SETUP_OUTPUT_LENGTH)}...",
		);
		expect(
			read(
				"packages/core/src/features/advanced-memory/providers/long-term-memory.ts",
			),
		).not.toContain("MAX_LONG_TERM_MEMORY_TEXT_LENGTH)}...");
	});

	it("boundary: exactly max length not truncated", () => {
		const max = 500;
		const text = "e".repeat(500);
		expect(oldTrunc(text, max).length).toBe(500);
		expect(fixedTrunc(text, max).length).toBe(500);
		expect(fixedTrunc(text, max)).toBe(text);
	});

	it("boundary: max+1 truncates to max", () => {
		const max = 500;
		const text = "f".repeat(501);
		expect(oldTrunc(text, max).length).toBe(503);
		expect(fixedTrunc(text, max).length).toBe(500);
	});
});
