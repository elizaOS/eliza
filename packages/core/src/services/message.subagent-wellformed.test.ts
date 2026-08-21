/**
 * Complete, surrogate-safe relay extraction for subAgentCompletionRelayBody.
 * Verifies long results remain intact while malformed Unicode is sanitized.
 */
import { describe, expect, it } from "vitest";
import { toWellFormedUnicode } from "../utils/well-formed";
import { subAgentCompletionRelayBody } from "./message";

function makeInput(body: string): string {
	return `[sub-agent:task_complete] ${body}`;
}

function expectDefinedRelayBody(
	body: string | undefined,
): asserts body is string {
	expect(body).toBeDefined();
}

describe("subAgentCompletionRelayBody surrogate safety", () => {
	const isWellFormed = (s: string): boolean => {
		const w = s as unknown as { isWellFormed?: () => boolean };
		if (typeof w.isWellFormed === "function") return w.isWellFormed();
		return toWellFormedUnicode(s) === s;
	};

	it("preserves an astral surrogate pair beyond the former 1500-character cap", () => {
		const body = `${"a".repeat(1498)}🦊${"b".repeat(20)}`;
		const out = subAgentCompletionRelayBody(makeInput(body));
		expect(out).toBe(body);
		expect(isWellFormed(out ?? "")).toBe(true);
		expect(() => JSON.stringify(out)).not.toThrow();
	});

	it("preserves a fitting astral emoji at the cap", () => {
		const body = `${"a".repeat(1497)}🦊`;
		// body length 1499, header adds but body itself is under cap? Actually 1497+2=1499 <=1500, so should be preserved as is
		const out = subAgentCompletionRelayBody(makeInput(body));
		expectDefinedRelayBody(out);
		expect(isWellFormed(out)).toBe(true);
		expect(out).toBe(toWellFormedUnicode(body));
	});

	it("preserves well-formed body under cap exactly at 1500 with emoji", () => {
		const body = `${"a".repeat(1498)}🦊`; // 1500 exactly
		const out = subAgentCompletionRelayBody(makeInput(body));
		expectDefinedRelayBody(out);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(1500);
		expect(out).toBe(toWellFormedUnicode(body));
	});

	it("sanitizes lone high surrogate", () => {
		const body = `ok \ud800 end ${"x".repeat(2000)}`;
		const out = subAgentCompletionRelayBody(makeInput(body));
		expectDefinedRelayBody(out);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("�")).toBe(true);
		expect(out.includes("\ud800")).toBe(false);
	});

	it("sanitizes lone low surrogate", () => {
		const body = `ok \udc00 end ${"x".repeat(2000)}`;
		const out = subAgentCompletionRelayBody(makeInput(body));
		expectDefinedRelayBody(out);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("�")).toBe(true);
	});

	it("preserves long well-formed bodies across a sweep of astral offsets", () => {
		for (let offset = 0; offset <= 20; offset++) {
			const body = `${"a".repeat(offset)}🦊${"b".repeat(2000)}`;
			const out = subAgentCompletionRelayBody(makeInput(body));
			expect(out).toBe(body);
			expect(isWellFormed(out ?? "")).toBe(true);
			expect(() => JSON.stringify(out)).not.toThrow();
		}
	});

	it("returns well-formed when under cap with lone surrogate and no truncation", () => {
		const body = "ok \ud800 end";
		const out = subAgentCompletionRelayBody(makeInput(body));
		expectDefinedRelayBody(out);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("�")).toBe(true);
		expect(out.includes("\ud800")).toBe(false);
	});

	it("preserves an ASCII body beyond the former cap", () => {
		const body = "a".repeat(2000);
		const out = subAgentCompletionRelayBody(makeInput(body));
		expect(out).toBe(body);
	});
});
