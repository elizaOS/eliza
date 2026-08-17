/**
 * Tests for lintDescriptionCompressed: validates hand-authored routing descriptions
 * for banned filler phrases, non-standard words, and non-imperative leading verbs.
 */
import { describe, expect, it } from "vitest";
import { lintDescriptionCompressed } from "./description-compressed-lint.js";

describe("lintDescriptionCompressed", () => {
	it("accepts a clean imperative description", () => {
		const result = lintDescriptionCompressed(
			"Fetch recent transaction records for the active wallet.",
		);
		expect(result.ok).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	it("rejects empty, nullish, or whitespace-only inputs", () => {
		expect(lintDescriptionCompressed("").ok).toBe(false);
		expect(lintDescriptionCompressed("   ").ok).toBe(false);
		expect(lintDescriptionCompressed(undefined as unknown as string).ok).toBe(
			false,
		);
		expect(lintDescriptionCompressed(null as unknown as string).ok).toBe(false);
	});

	it("flags banned filler phrases case-insensitively", () => {
		const r1 = lintDescriptionCompressed(
			"Fetch records in order to verify balance.",
		);
		expect(r1.ok).toBe(false);
		expect(r1.violations.some((v) => v.includes("in order to"))).toBe(true);

		const r2 = lintDescriptionCompressed(
			"Please query the system for user info.",
		);
		expect(r2.ok).toBe(false);
		expect(r2.violations.some((v) => v.includes("please"))).toBe(true);

		const r3 = lintDescriptionCompressed(
			"This action syncs wallet state with the ledger.",
		);
		expect(r3.ok).toBe(false);
		expect(r3.violations.some((v) => v.includes("this action"))).toBe(true);
	});

	it("flags banned long-form words", () => {
		const r1 = lintDescriptionCompressed("Read unread messages from channel.");
		expect(r1.ok).toBe(false);
		expect(r1.violations.some((v) => v.includes("messages"))).toBe(true);

		const r2 = lintDescriptionCompressed("Load server configuration on boot.");
		expect(r2.ok).toBe(false);
		expect(r2.violations.some((v) => v.includes("configuration"))).toBe(true);
	});

	it("flags non-imperative leading verbs in both titlecase and lowercase", () => {
		const r1 = lintDescriptionCompressed(
			"Provides account summary and transaction breakdown.",
		);
		expect(r1.ok).toBe(false);
		expect(r1.violations.some((v) => v.includes("Provides"))).toBe(true);

		const r2 = lintDescriptionCompressed(
			"provides account summary and transaction breakdown.",
		);
		expect(r2.ok).toBe(false);
		expect(r2.violations.some((v) => v.includes("provides"))).toBe(true);

		const r3 = lintDescriptionCompressed("Helps user manage tasks.");
		expect(r3.ok).toBe(false);
		expect(r3.violations.some((v) => v.includes("Helps"))).toBe(true);

		const r4 = lintDescriptionCompressed("helps user manage tasks.");
		expect(r4.ok).toBe(false);
		expect(r4.violations.some((v) => v.includes("helps"))).toBe(true);
	});
});
