/**
 * Unit tests for lintDescriptionCompressed in packages/core/src/utils/description-compressed-lint.ts.
 * Exercises imperative starting verbs, case-insensitive leading word detection,
 * banned phrases, banned words, empty inputs, and violation aggregation.
 */
import { describe, expect, it } from "vitest";
import { lintDescriptionCompressed } from "./description-compressed-lint.js";

describe("lintDescriptionCompressed", () => {
	it("accepts clean imperative descriptions", () => {
		const result = lintDescriptionCompressed(
			"Search issues and pull requests by keyword or label",
		);
		expect(result.ok).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	it("flags empty or whitespace-only inputs", () => {
		expect(lintDescriptionCompressed("").ok).toBe(false);
		expect(lintDescriptionCompressed("   ").ok).toBe(false);
		expect(
			lintDescriptionCompressed(null as unknown as string).violations[0],
		).toContain("empty");
	});

	it("flags banned phrases", () => {
		const result = lintDescriptionCompressed(
			"Use this action in order to search data for the user",
		);
		expect(result.ok).toBe(false);
		expect(result.violations.some((v) => v.includes("in order to"))).toBe(true);
		expect(result.violations.some((v) => v.includes("use this action"))).toBe(
			true,
		);
		expect(result.violations.some((v) => v.includes("the user"))).toBe(true);
	});

	it("flags banned words suggesting preferred abbreviations", () => {
		const result = lintDescriptionCompressed(
			"Fetch all messages and load configuration",
		);
		expect(result.ok).toBe(false);
		expect(result.violations.some((v) => v.includes("messages"))).toBe(true);
		expect(result.violations.some((v) => v.includes("configuration"))).toBe(
			true,
		);
	});

	it("flags non-imperative leading verbs across title-case, lower-case, and upper-case", () => {
		const titleCase = lintDescriptionCompressed("Provides search results");
		expect(titleCase.ok).toBe(false);
		expect(titleCase.violations[0]).toContain("non-imperative");

		const lowerCase = lintDescriptionCompressed("provides search results");
		expect(lowerCase.ok).toBe(false);
		expect(lowerCase.violations[0]).toContain("non-imperative");

		const upperCase = lintDescriptionCompressed("PROVIDES search results");
		expect(upperCase.ok).toBe(false);
		expect(upperCase.violations[0]).toContain("non-imperative");

		const helps = lintDescriptionCompressed("helps users find records");
		expect(helps.ok).toBe(false);
		expect(helps.violations[0]).toContain("non-imperative");
	});
});
