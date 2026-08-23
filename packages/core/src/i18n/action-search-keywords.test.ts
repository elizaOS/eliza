/**
 * Unit tests for action search keyword extraction, stem conversion, and term matching.
 */

import { describe, expect, it } from "vitest";
import {
	actionNameToKeywordStem,
	countActionSearchKeywordMatches,
	getActionSearchKeywordSources,
	getActionSearchKeywordTerms,
} from "./action-search-keywords.js";

describe("action-search-keywords", () => {
	it("converts action names to camelCase keyword stems", () => {
		expect(actionNameToKeywordStem("SEND_MESSAGE")).toBe("sendMessage");
		expect(actionNameToKeywordStem("CREATE_TASK")).toBe("createTask");
		expect(actionNameToKeywordStem("webSearch")).toBe("webSearch");
		expect(actionNameToKeywordStem("   ")).toBe("");
	});

	it("extracts keyword sources for actions and associated contexts", () => {
		const sources = getActionSearchKeywordSources({
			name: "CREATE_TASK",
			contexts: ["tasks", "productivity"],
		});

		expect(Array.isArray(sources)).toBe(true);
		expect(sources.length).toBeGreaterThan(0);

		const keys = sources.map((s) => s.key);
		expect(
			keys.some(
				(k) =>
					k.includes("action.createTask") || k.includes("contextSignal.tasks"),
			),
		).toBe(true);

		for (const source of sources) {
			expect(typeof source.key).toBe("string");
			expect(Array.isArray(source.terms)).toBe(true);
			expect(source.terms.length).toBeGreaterThan(0);
		}
	});

	it("extracts deduplicated keyword terms", () => {
		const terms = getActionSearchKeywordTerms({
			name: "SEND_MESSAGE",
			contexts: ["messaging"],
		});

		expect(Array.isArray(terms)).toBe(true);
		expect(terms.length).toBeGreaterThan(0);

		const lowerTerms = terms.map((t) => t.toLowerCase());
		const unique = new Set(lowerTerms);
		expect(lowerTerms.length).toBe(unique.size);
	});

	it("counts keyword term matches against candidate texts", () => {
		const texts = ["Can you send a message to Alice?", "Check my email"];
		const terms = ["send", "message", "nonexistent"];

		const matchCount = countActionSearchKeywordMatches(texts, terms);
		expect(matchCount).toBe(2);
	});
});
