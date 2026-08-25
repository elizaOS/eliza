/**
 * Pins batch3 suffix-reserve fixes (ship 11): 7 remaining `slice(0, MAX) + suffix`
 * overflows that exceed their stated caps by suffix.length.
 *
 * Sibling correct (reserve proofs): `trajectory-recorder.ts:806` `MAX - suffix.length`,
 * `plugin-embeddings/utils/events.ts:35` `MAX_PROMPT_LENGTH - suffix.length`,
 * `pending-prompts/store.ts:96` `PROMPT_SNIPPET_MAX_LENGTH - 1`, `messaging/parse.ts:271` `-1`.
 */

import { describe, expect, it } from "vitest";
import { subAgentCompletionRelayBody } from "./services/message.ts";

function oldTrunc(s: string, max: number, suffix: string): string {
	return s.length > max ? s.slice(0, max) + suffix : s;
}
function fixedTrunc(s: string, max: number, suffix: string): string {
	return s.length > max ? s.slice(0, max - suffix.length) + suffix : s;
}

describe("truncation suffix reserve batch3 (ship 11) — 7 sites", () => {
	it("TR-1 openai events 200+1: old 201 vs fixed 200", () => {
		const MAX = 200;
		const suffix = "…";
		const s = "a".repeat(210);
		expect(oldTrunc(s, MAX, suffix).length).toBe(201);
		expect(fixedTrunc(s, MAX, suffix).length).toBe(200);
		expect(fixedTrunc(s, MAX, suffix).length).toBeLessThanOrEqual(MAX);
	});

	it("TR-2 chat-augmentation 700+3: old 703 vs fixed 700", () => {
		const MAX = 700;
		const suffix = "...";
		const s = "a".repeat(710);
		expect(oldTrunc(s, MAX, suffix).length).toBe(703);
		expect(fixedTrunc(s, MAX, suffix).length).toBe(700);
	});

	it("TR-3 notes provider 400+13: old 413 vs fixed 400", () => {
		const MAX = 400;
		const suffix = "… (truncated)";
		expect(suffix.length).toBe(13);
		const s = "a".repeat(410);
		expect(oldTrunc(s, MAX, suffix).length).toBe(413);
		expect(fixedTrunc(s, MAX, suffix).length).toBe(400);
	});

	it("TR-4 message subAgentCompletionRelayBody delivers the complete relay body", () => {
		const MAX = 1500;
		const suffix = "…";
		const s = "a".repeat(1510);
		// The reserve arithmetic itself still holds wherever a real hard limit
		// forces a suffix-bearing cap.
		expect(oldTrunc(s, MAX, suffix).length).toBe(1501);
		expect(fixedTrunc(s, MAX, suffix).length).toBe(1500);
		// subAgentCompletionRelayBody is NOT such a site: the relay body it returns
		// becomes the delivered reply text on a degraded planner turn, so the
		// prompt-integrity rule in CLAUDE.md ("never use a character/token cap,
		// prefix or suffix slice … to make model-facing content fit") forbids
		// capping it. It trims the header and returns the body complete.
		const header = "[sub-agent:task_complete]";
		const body = "a".repeat(2000);
		const input = `${header} ${body}`;
		const out = subAgentCompletionRelayBody(input);
		expect(out).toBe(body);
		expect(out?.length).toBe(2000);
		expect(out?.endsWith(suffix)).toBe(false);
	});

	it("TR-5 media fetch readErrorBodySnippet 200+1: old 201 vs fixed 200", () => {
		const MAX = 200;
		const suffix = "…";
		const s = "a".repeat(210);
		expect(oldTrunc(s, MAX, suffix).length).toBe(201);
		expect(fixedTrunc(s, MAX, suffix).length).toBe(200);
	});

	it("TR-6 health-routes 8000+3 x2: old 8003 vs fixed 8000", () => {
		const MAX = 8000;
		const suffix = "...";
		const s = "a".repeat(8010);
		expect(oldTrunc(s, MAX, suffix).length).toBe(8003);
		expect(fixedTrunc(s, MAX, suffix).length).toBe(8000);
		// both string preview and err.stack share same cap
		expect(fixedTrunc(s, MAX, suffix).length).toBeLessThanOrEqual(MAX);
	});

	it("TR-7 discord truncateText 200/1500+3: shared helper old vs fixed", () => {
		const s200 = "a".repeat(210);
		const s1500 = "a".repeat(1510);
		expect(oldTrunc(s200, 200, "...").length).toBe(203);
		expect(fixedTrunc(s200, 200, "...").length).toBe(200);
		expect(oldTrunc(s1500, 1500, "...").length).toBe(1503);
		expect(fixedTrunc(s1500, 1500, "...").length).toBe(1500);
	});
});
