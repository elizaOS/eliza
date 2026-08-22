/**
 * Unicode well-formedness for subAgentCompletionRelayBody. The relay body is
 * COMPLETE model context — the former 1500-char cap was retired (#24134):
 * bodies of any length pass through whole, and the only transformation is
 * lone-surrogate sanitization via toWellFormedUnicode.
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

	it("preserves a long body COMPLETE — no cap, no ellipsis", () => {
		const body = `${"a".repeat(1498)}🦊${"b".repeat(20)}`;
		const out = subAgentCompletionRelayBody(makeInput(body));
		expect(out).toBeDefined();
		expect(isWellFormed(out!)).toBe(true);
		expect(out).toBe(body);
		expect(out!.endsWith("…")).toBe(false);
		expect(() => JSON.stringify(out)).not.toThrow();
	});

	it("preserves an astral emoji at any position", () => {
		const body = `${"a".repeat(1497)}🦊`;
		const out = subAgentCompletionRelayBody(makeInput(body));
		expect(out).toBeDefined();
		expect(isWellFormed(out!)).toBe(true);
		expect(out).toBe(toWellFormedUnicode(body));
	});

	it("preserves a well-formed 1500-char body byte-for-byte", () => {
		const body = `${"a".repeat(1498)}🦊`; // 1500 chars exactly
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
		expect(out!.includes("\ufffd")).toBe(true);
		expect(out!.includes("\ud800")).toBe(false);
	});

	it("sanitizes lone low surrogate", () => {
		const body = `ok \udc00 end ${"x".repeat(2000)}`;
		const out = subAgentCompletionRelayBody(makeInput(body));
		expect(out).toBeDefined();
		expect(isWellFormed(out!)).toBe(true);
		expect(out!.includes("\ufffd")).toBe(true);
	});

	it("stays well-formed and complete across a sweep of astral offsets", () => {
		for (let offset = 0; offset <= 20; offset++) {
			const body = `${"a".repeat(offset)}🦊${"b".repeat(2000)}`;
			const out = subAgentCompletionRelayBody(makeInput(body));
			expect(isWellFormed(out!)).toBe(true);
			expect(out).toBe(body);
			expect(() => JSON.stringify(out)).not.toThrow();
		}
	});

	it("returns well-formed for a short body with a lone surrogate", () => {
		const body = "ok \ud800 end";
		const out = subAgentCompletionRelayBody(makeInput(body));
		expect(out).toBeDefined();
		expect(isWellFormed(out!)).toBe(true);
		expect(out!.includes("\ufffd")).toBe(true);
		expect(out!.includes("\ud800")).toBe(false);
	});

	it("passes a 2000-char ASCII body through whole", () => {
		const body = "a".repeat(2000);
		const out = subAgentCompletionRelayBody(makeInput(body));
		expect(out).toBeDefined();
		expect(out).toBe(body);
		expect(out!.endsWith("…")).toBe(false);
	});
});
