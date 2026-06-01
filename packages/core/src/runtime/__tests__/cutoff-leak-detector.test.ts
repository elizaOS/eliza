import { describe, expect, it } from "vitest";

import { looksLikeTrainingCutoffLeak } from "../cutoff-leak-detector";

describe("looksLikeTrainingCutoffLeak", () => {
	describe("matches the training-metadata phrases forbidden by the prompt rule", () => {
		const leaks = [
			"As of my training data, the latest stable release is 18.2.",
			"As of my last update, that team hadn't shipped it yet.",
			"As of my knowledge, the API still uses v1 auth.",
			"My knowledge cutoff is April 2023, so I can't be sure.",
			"My knowledge cut-off means I might be out of date here.",
			"That predates my training cutoff.",
			"I was trained on data up to 2023.",
			"I was trained on a static corpus, so newer events are missing.",
			"I was last updated some time ago, so this may be stale.",
			"I was last trained before that release.",
			"The latest information I have is from early 2023.",
			"The latest data I have goes up to 2023.",
			"Based on my training data, the answer is X.",
			"Based on data through 2023, the population was Y.",
			"Based on the data I was trained on, that's correct.",
			"It's in my training data, but I can't verify it's current.",
		];
		for (const text of leaks) {
			it(`matches: "${text.slice(0, 60)}"`, () => {
				expect(looksLikeTrainingCutoffLeak(text)).toBe(true);
			});
		}
	});

	describe("does NOT match honest replies, date answers, or third-party 'training data' talk", () => {
		const clean = [
			"Today is June 1, 2026.",
			"The current year is 2026.",
			"Let me check the latest information for you.",
			"I'll pull the latest data from the API now.",
			"I don't have live access to check that — try the status page.",
			"You'll need to update the training data for your own model first.",
			"The model's accuracy improved after we expanded the training set.",
			"Sure, I can help with that.",
			"On it — fetching the current price now.",
			"Here's what the docs say about cutoff handling in the parser.",
		];
		for (const text of clean) {
			it(`does not match: "${text.slice(0, 60)}"`, () => {
				expect(looksLikeTrainingCutoffLeak(text)).toBe(false);
			});
		}
	});

	describe("guards on empty / short / non-string inputs", () => {
		it("returns false for undefined", () => {
			expect(looksLikeTrainingCutoffLeak(undefined)).toBe(false);
		});
		it("returns false for null", () => {
			expect(looksLikeTrainingCutoffLeak(null)).toBe(false);
		});
		it("returns false for empty string", () => {
			expect(looksLikeTrainingCutoffLeak("")).toBe(false);
		});
		it("returns false for non-string (number)", () => {
			expect(
				looksLikeTrainingCutoffLeak(123 as unknown as string),
			).toBe(false);
		});
	});
});
