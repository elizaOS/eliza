/**
 * Surrogate-safe truncation for subAgentCompletionRelayBody.
 * Verifies the 1500-char cap never splits an astral surrogate pair and sanitizes lone surrogates.
 */
import { describe, expect, it } from "vitest";
import { toWellFormedUnicode } from "../utils/well-formed";
import { subAgentCompletionRelayBody } from "./message";

function makeInput(body: string): string {
	return `[sub-agent:task_complete] ${body}`;
}

describe("subAgentCompletionRelayBody surrogate safety", () => {
	const isWellFormed = (s: string): boolean => {
		const w = s as unknown as { isWellFormed?: () => boolean };
		if (typeof w.isWellFormed === "function") return w.isWellFormed();
		return toWellFormedUnicode(s) === s;
	};

	it("backs off when truncation would split a surrogate pair at 1500", () => {
		const body = `${"a".repeat(1498)}🦊${"b".repeat(20)}`;
		const out = subAgentCompletionRelayBody(makeInput(body));
		expect(out).toBeDefined();
		expect(isWellFormed(out!)).toBe(true);
		expect(out!.endsWith("…")).toBe(true);
		expect(out!.length).toBeLessThanOrEqual(1500);
		expect(() => JSON.stringify(out)).not.toThrow();
	});

	it("preserves a fitting astral emoji at the cap", () => {
		const body = `${"a".repeat(1497)}🦊`;
		// body length 1499, header adds but body itself is under cap? Actually 1497+2=1499 <=1500, so should be preserved as is
		const out = subAgentCompletionRelayBody(makeInput(body));
		expect(out).toBeDefined();
		expect(isWellFormed(out!)).toBe(true);
		expect(out).toBe(toWellFormedUnicode(body));
	});

	it("preserves well-formed body under cap exactly at 1500 with emoji", () => {
		const body = `${"a".repeat(1498)}🦊`; // 1500 exactly
		const out = subAgentCompletionRelayBody(makeInput(body));
		expect(out).toBeDefined();
		expect(isWellFormed(out!)).toBe(true);
		expect(out!.length).toBe(1500);
		expect(out).toBe(toWellFormedUnicode(body));
	});

	it("sanitizes lone high surrogate", () => {
		const body = `ok \ud800 end ${"x".repeat(2000)}`;
		const out = subAgentCompletionRelayBody(makeInput(body));
		expect(out).toBeDefined();
		expect(isWellFormed(out!)).toBe(true);
		expect(out!.includes("�")).toBe(true);
		expect(out!.includes("\ud800")).toBe(false);
	});

	it("sanitizes lone low surrogate", () => {
		const body = `ok \udc00 end ${"x".repeat(2000)}`;
		const out = subAgentCompletionRelayBody(makeInput(body));
		expect(out).toBeDefined();
		expect(isWellFormed(out!)).toBe(true);
		expect(out!.includes("�")).toBe(true);
	});

	it("stays well-formed across sweep of offsets (cap 1500, test with smaller cap via long body)", () => {
		for (let offset = 0; offset <= 20; offset++) {
			const body = `${"a".repeat(offset)}🦊${"b".repeat(2000)}`;
			const out = subAgentCompletionRelayBody(makeInput(body));
			expect(isWellFormed(out!)).toBe(true);
			expect(out!.length).toBeLessThanOrEqual(1500);
			expect(() => JSON.stringify(out)).not.toThrow();
		}
	});

	it("returns well-formed when under cap with lone surrogate and no truncation", () => {
		const body = "ok \ud800 end";
		const out = subAgentCompletionRelayBody(makeInput(body));
		expect(out).toBeDefined();
		expect(isWellFormed(out!)).toBe(true);
		expect(out!.includes("�")).toBe(true);
		expect(out!.includes("\ud800")).toBe(false);
	});

	it("caps at 1500 with 1499 content chars + ellipsis for ASCII overflow", () => {
		const body = "a".repeat(2000);
		const out = subAgentCompletionRelayBody(makeInput(body));
		expect(out).toBeDefined();
		expect(out!.length).toBe(1500);
		expect(out!.endsWith("…")).toBe(true);
		expect(out!.slice(0, -1).trimEnd().length).toBe(1499);
	});
});
