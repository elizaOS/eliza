/**
 * Isolated hang tests for linear wildcard action-hint matching.
 * Deterministic — no catalog, planner, or logger.
 */
import { describe, expect, it } from "vitest";
import { matchActionWildcardParts } from "./action-wildcard-glob.ts";

describe("matchActionWildcardParts", () => {
	it("preserves GMAIL_* / GMAIL_SEND* / *_DRAFT shapes", () => {
		expect(matchActionWildcardParts(["GMAIL_", ""], "GMAIL_SEND")).toBe(true);
		expect(matchActionWildcardParts(["GMAIL_", ""], "GMAILSYNC")).toBe(false);
		expect(matchActionWildcardParts(["GMAIL_SEND", ""], "GMAIL_SEND")).toBe(
			true,
		);
		expect(
			matchActionWildcardParts(["GMAIL_SEND", ""], "GMAIL_SEND_LATER"),
		).toBe(true);
		expect(matchActionWildcardParts(["GMAIL_SEND", ""], "GMAILSYNC")).toBe(
			false,
		);
		expect(matchActionWildcardParts(["", "SYNC"], "GMAILSYNC")).toBe(true);
		expect(
			matchActionWildcardParts(["GMAIL", "_", "DRAFT"], "GMAIL_CREATE_DRAFT"),
		).toBe(true);
		expect(
			matchActionWildcardParts(["GMAIL", "_", "DRAFT"], "GMAILCREATEDRAFT"),
		).toBe(false);
	});

	it("rejects a 14-star fail-closed hint in well under the origin regex hang", () => {
		const parts = [...Array.from({ length: 14 }, () => "A"), "Z"];
		const name = "A".repeat(40);
		const t0 = performance.now();
		expect(matchActionWildcardParts(parts, name)).toBe(false);
		expect(performance.now() - t0).toBeLessThan(20);
	});
});
