/** Exercises lightweight email validation, span extraction, redaction, and pathological-input performance. */
import { describe, expect, it } from "vitest";
import {
	basicEmailValid,
	findBasicEmailSpans,
	redactBasicEmails,
} from "./basic-email";

describe("basic email helpers", () => {
	it("accepts the lightweight local@domain.tld shape", () => {
		expect(basicEmailValid("jane.doe+ops@example.co")).toBe(true);
		expect(basicEmailValid("a@b.c")).toBe(true);
	});

	it("rejects malformed or whitespace-containing values", () => {
		expect(basicEmailValid("missing-at.example")).toBe(false);
		expect(basicEmailValid("a@@b.c")).toBe(false);
		expect(basicEmailValid("a@b")).toBe(false);
		expect(basicEmailValid("a @b.c")).toBe(false);
	});

	it("finds spans without swallowing sentence punctuation", () => {
		expect(findBasicEmailSpans("email jane@example.com.")).toEqual([
			{ value: "jane@example.com", start: 6, end: 22 },
		]);
		expect(redactBasicEmails("email jane@example.com.")).toBe("email [EMAIL].");
	});

	it("is linear on pathological single-at dot runs", () => {
		const evil = `user@${".".repeat(300_000)}!`;
		const start = performance.now();
		expect(findBasicEmailSpans(evil)).toEqual([]);
		expect(performance.now() - start).toBeLessThan(1000);
	});
});
