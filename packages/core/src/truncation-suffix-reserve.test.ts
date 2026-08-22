/**
 * Pins prompt-cap truncation suffix reservation: every site must reserve
 * `suffix.length` so the final string never exceeds its MAX.
 * Guards the `slice(0,MAX)+suffix` overflow where `MAX+len(suffix)` leaked
 * past the advertised cap (e.g. 32000+87=32087, 2000+15=2015, 500+3=503).
 * Sibling correct: runtime/trajectory-recorder.ts:806
 * `RECORD_SANITIZE_MAX - suffix.length` and plugin-browser/message-adapter:52 `497`.
 */
import { describe, expect, it } from "vitest";
import { truncateEntityMetadata } from "./entities.ts";
import { attachmentContentForAnswering } from "./features/working-memory/readAttachmentAction.ts";

const MAX_ATTACHMENT = 32_000;
const ATTACHMENT_SUFFIX = `\n\n[Attachment content truncated before answering because it exceeded ${MAX_ATTACHMENT} characters.]`;
const MAX_ENTITY = 2_000;
const ENTITY_SUFFIX = "... (truncated)";
const MAX_RUNTIME = 500;
const RUNTIME_SUFFIX = "...";
const SETTINGS_MAX = 12_000;
const LONG_TERM_MAX = 5_000;
const SUMMARY_MAX = 3_000;
const GENERIC_SUFFIX = "...";

function oldTruncate(text: string, max: number, suffix: string): string {
	return text.length > max ? `${text.slice(0, max)}${suffix}` : text;
}
function newTruncate(text: string, max: number, suffix: string): string {
	return text.length > max
		? `${text.slice(0, max - suffix.length)}${suffix}`
		: text;
}

describe("truncation suffix reservation — 7-site batch", () => {
	it("attachment: 32001 chars truncates to exactly 32000 with suffix", () => {
		const input = "a".repeat(MAX_ATTACHMENT + 1);
		const out = attachmentContentForAnswering(input);
		expect(out.length).toBe(MAX_ATTACHMENT);
		expect(out.endsWith(ATTACHMENT_SUFFIX)).toBe(true);
		// old would overflow 87
		const old = oldTruncate(input, MAX_ATTACHMENT, ATTACHMENT_SUFFIX);
		expect(old.length).toBe(MAX_ATTACHMENT + ATTACHMENT_SUFFIX.length);
		expect(old.length).toBe(32_087);
	});

	it("attachment: at cap returns verbatim, over cap reserves", () => {
		const atCap = "a".repeat(MAX_ATTACHMENT);
		expect(attachmentContentForAnswering(atCap).length).toBe(MAX_ATTACHMENT);
		expect(attachmentContentForAnswering(atCap)).toBe(atCap);
		const over = "a".repeat(MAX_ATTACHMENT + 50);
		expect(attachmentContentForAnswering(over).length).toBe(MAX_ATTACHMENT);
	});

	it("entity metadata: 2001-char render truncates to 2000 with suffix", () => {
		// Build metadata that renders >2000 via stableStringify of a large string field
		const big = "x".repeat(MAX_ENTITY + 100);
		const out = truncateEntityMetadata({ note: big });
		expect(out.length).toBeLessThanOrEqual(MAX_ENTITY);
		expect(out.endsWith(ENTITY_SUFFIX)).toBe(true);
		const old = oldTruncate(
			"a".repeat(MAX_ENTITY + 1),
			MAX_ENTITY,
			ENTITY_SUFFIX,
		);
		expect(old.length).toBe(2_015);
	});

	it("runtime validated fields: 501 chars truncate to 500, not 503", () => {
		const input = "a".repeat(MAX_RUNTIME + 1);
		const fixed = newTruncate(input, MAX_RUNTIME, RUNTIME_SUFFIX);
		expect(fixed.length).toBe(MAX_RUNTIME);
		const buggy = oldTruncate(input, MAX_RUNTIME, RUNTIME_SUFFIX);
		expect(buggy.length).toBe(503);
		// also 500 exactly stays
		expect(newTruncate("a".repeat(500), 500, "...").length).toBe(500);
	});

	it("settings / long-term / summary: caps reserve 3 for ...", () => {
		for (const [max, label] of [
			[SETTINGS_MAX, "settings 12000"],
			[LONG_TERM_MAX, "long-term 5000"],
			[SUMMARY_MAX, "summary 3000"],
		] as const) {
			const input = "a".repeat(max + 1);
			const fixed = newTruncate(input, max, GENERIC_SUFFIX);
			const buggy = oldTruncate(input, max, GENERIC_SUFFIX);
			expect(fixed.length, label).toBe(max);
			expect(buggy.length, `${label} old`).toBe(max + 3);
		}
	});

	it("sabotage: old branch leaks past cap, new does not", () => {
		const cases: Array<[number, string, number]> = [
			[MAX_ATTACHMENT, ATTACHMENT_SUFFIX, 87],
			[MAX_ENTITY, ENTITY_SUFFIX, 15],
			[MAX_RUNTIME, RUNTIME_SUFFIX, 3],
			[SETTINGS_MAX, GENERIC_SUFFIX, 3],
		];
		for (const [max, suffix, over] of cases) {
			const input = "a".repeat(max + 1);
			expect(oldTruncate(input, max, suffix).length).toBe(max + over);
			expect(newTruncate(input, max, suffix).length).toBe(max);
			expect(newTruncate(input, max, suffix).length).not.toBe(max + over);
		}
	});
});
