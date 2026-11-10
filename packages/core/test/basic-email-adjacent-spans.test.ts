/**
 * Two addresses joined by a character that may sit in a local part
 * ("alice@example.com/bob@example.org") must give two spans that do not
 * overlap. detectPii keeps the longest of two overlapping spans, so a second
 * span that reaches back into the first address drops the first address and
 * leaves "alice@" in redacted and model-bound text.
 */
import { describe, expect, it } from "vitest";
import { findBasicEmailSpans } from "../src/security/basic-email.ts";
import { detectPii } from "../src/security/pii-detectors.ts";
import { SecretSwapSession } from "../src/security/secret-swap.ts";

const TEXT = "Please cc alice@example.com/bob@example.org on the invite";

describe("findBasicEmailSpans with adjacent addresses", () => {
	it("does not start a local part inside the previous address", () => {
		expect(findBasicEmailSpans(TEXT)).toEqual([
			{ value: "alice@example.com", start: 10, end: 27 },
			{ value: "/bob@example.org", start: 27, end: 43 },
		]);
	});

	it("keeps both addresses for each separator a local part accepts", () => {
		for (const separator of ["/", "|", "+", "!", "~"]) {
			const text = `alice@example.com${separator}bob@example.org`;
			const spans = findBasicEmailSpans(text);
			expect(spans.map((span) => span.value)).toEqual([
				"alice@example.com",
				`${separator}bob@example.org`,
			]);
		}
	});
});

describe("detectPii with adjacent addresses", () => {
	it("covers the first address as well as the second", () => {
		const emails = detectPii(TEXT).filter((match) => match.kind === "email");
		expect(emails.map((match) => match.value)).toEqual([
			"alice@example.com",
			"/bob@example.org",
		]);
	});
});

describe("SecretSwapSession with adjacent addresses", () => {
	it("hides both addresses from the model and restores them", () => {
		const session = new SecretSwapSession({ knownSecrets: {} });
		const swapped = session.substituteText(TEXT);
		expect(swapped).not.toContain("alice");
		expect(swapped).not.toContain("bob");
		expect(session.restoreText(swapped)).toBe(TEXT);
	});
});
