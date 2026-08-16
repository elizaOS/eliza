/**
 * Pins Ship 21 trunc suffix reserve batch (systematic overflow by suffix length):
 * - settings-debug.ts:60 `slice(0, MAX_STRING)}…` (120+1=121) → `MAX-1`
 * - recent-errors.ts:66 `slice(0, MAX_CONTEXT_CHARS)}…` → `-1`
 * - replyContext.ts:54 `slice(0, maxChars)}…` / 66 `slice(0, MAX_REPLY_WINDOW_MESSAGE_CHARS)}…` → `-1`
 * - actionState.ts:256 `slice(0, MAX_THOUGHT_CHARS)}…` → `-1`
 * - reference-echo.ts:33 `slice(0,120)}…` → `120-1 (119)`
 * - tts-debug.ts:64 `slice(0, maxChars)}…` → `-1`
 * - reflection-items.ts:449 `slice(0, maxChars)}…[truncated]` (max+12) → `max - "…[truncated]".length`
 * Sibling correct: trajectory-recorder 806 `MAX - suffix.length`, pending-prompts/store 96 `-1`, cockpit-modes 250 `-1`, naming 13 `-1`, etc.
 */

import { describe, expect, it } from "vitest";

function oldTruncSingle(text: string, max: number, suffix = "…") {
	return text.length > max ? `${text.slice(0, max)}${suffix}` : text;
}
function fixedTruncSingle(text: string, max: number, suffix = "…") {
	const reserve = suffix.length;
	return text.length > max ? `${text.slice(0, max - reserve)}${suffix}` : text;
}
function oldTruncLong(text: string, max: number) {
	const suffix = "…[truncated]";
	return text.length > max ? `${text.slice(0, max)}${suffix}` : text;
}
function fixedTruncLong(text: string, max: number) {
	const suffix = "…[truncated]";
	return text.length > max
		? `${text.slice(0, max - suffix.length)}${suffix}`
		: text;
}

describe("trunc suffix reserve batch (ship 21) — 8 sites", () => {
	it("single-char suffix overflow old max+1 vs fixed max", () => {
		const max = 120;
		const text = "a".repeat(200);
		const old = oldTruncSingle(text, max);
		const fixed = fixedTruncSingle(text, max);
		expect(old.length).toBe(max + 1); // 121 overflow
		expect(fixed.length).toBe(max); // 120 bounded
		expect(fixed).toBe("a".repeat(119) + "…");
		// payload specific
		expect(old.slice(0, 5)).toBe("aaaaa");
	});

	it("long suffix …[truncated] overflow old max+12 vs fixed max", () => {
		const max = 240;
		const text = "b".repeat(300);
		const old = oldTruncLong(text, max);
		const fixed = fixedTruncLong(text, max);
		expect(old.length).toBe(max + 12); // 252 overflow
		expect(fixed.length).toBe(max); // 240 bounded
		expect(fixed.endsWith("…[truncated]")).toBe(true);
		expect(fixed.length).toBe(240);
	});

	it("120 literal site reference-echo: old 121 vs fixed 120", () => {
		const max = 120;
		const text = "c".repeat(200);
		const old = `${text.slice(0, max)}…`;
		const fixed = `${text.slice(0, max - 1)}…`;
		expect(old.length).toBe(121);
		expect(fixed.length).toBe(120);
	});

	it("ship21 sibling proof: files reserve suffix length", async () => {
		const fs = await import("node:fs");
		const read = (p: string) => fs.readFileSync(p, "utf8");
		expect(read("packages/core/src/settings-debug.ts")).toContain(
			"MAX_STRING - 1",
		);
		expect(read("packages/core/src/providers/recent-errors.ts")).toContain(
			"MAX_CONTEXT_CHARS - 1",
		);
		expect(
			read(
				"packages/core/src/features/basic-capabilities/providers/replyContext.ts",
			),
		).toContain("maxChars - 1");
		expect(
			read(
				"packages/core/src/features/basic-capabilities/providers/replyContext.ts",
			),
		).toContain("MAX_REPLY_WINDOW_MESSAGE_CHARS - 1");
		expect(
			read(
				"packages/core/src/features/basic-capabilities/providers/actionState.ts",
			),
		).toContain("MAX_THOUGHT_CHARS - 1");
		expect(read("packages/core/src/utils/reference-echo.ts")).toContain(
			"120 - 1",
		);
		expect(read("packages/ui/src/utils/tts-debug.ts")).toContain(
			"maxChars - 1",
		);
		expect(
			read(
				"packages/core/src/features/advanced-capabilities/evaluators/reflection-items.ts",
			),
		).toContain('maxChars - "…[truncated]".length');
		// sibling correct still present
		expect(read("packages/core/src/runtime/trajectory-recorder.ts")).toContain(
			"RECORD_SANITIZE_MAX_STRING_CHARS - RECORD_SANITIZE_TRUNCATION_SUFFIX.length",
		);
		expect(
			read("packages/agent/src/services/pending-prompts/store.ts"),
		).toContain("PROMPT_SNIPPET_MAX_LENGTH - 1");
		// ensure old patterns gone
		expect(read("packages/core/src/settings-debug.ts")).not.toContain(
			"MAX_STRING)}…",
		);
		expect(read("packages/ui/src/utils/tts-debug.ts")).not.toContain(
			"maxChars)}…",
		);
	});
});
