import { describe, expect, it } from "vitest";

import { looksLikeFabricatedModeration } from "../fabricated-moderation-detector";

describe("looksLikeFabricatedModeration", () => {
	describe("matches fabricated-moderation claims forbidden by the prompt rule", () => {
		const fabrications = [
			"Your request was flagged as hateful, so I can't continue.",
			"That violates our usage policies.",
			"This goes against our content guidelines.",
			"Your message was blocked by the system.",
			"Your previous message was rejected.",
			"My content filter prevented me from answering.",
			"I was blocked from answering that question.",
			"I'm blocked from doing that here.",
			"My safety guidelines prohibit this.",
			"Our usage policies don't allow that.",
			"The system automatically blocked your request.",
			"The system flagged that message.",
			"Your previous message contained hateful language.",
			"My content moderation system caught that.",
		];
		for (const text of fabrications) {
			it(`matches: "${text.slice(0, 60)}"`, () => {
				expect(looksLikeFabricatedModeration(text)).toBe(true);
			});
		}
	});

	describe("does NOT match third-party policies or genuine runtime errors", () => {
		const clean = [
			"Stripe's usage policies require a verified business account.",
			"Their content guidelines are stricter than ours used to be.",
			"The request was blocked by CORS — try the API origin instead.",
			"Your request was blocked by CORS — try the API origin instead.",
			"The auth system blocked the request because the token expired.",
			"The firewall blocked the connection on port 8080.",
			"It was flagged as harmful by Reddit's moderation queue.",
			"The dataset contained hateful content in several rows.",
			"I'd rather not get into that one.",
			"I'm not going to help with that.",
			"That's not something I'll do, but here's an alternative.",
			"The build failed because the linter flagged an unused import.",
			"Let me review the content of that file for you.",
			"Sure — I'll filter the results by date.",
		];
		for (const text of clean) {
			it(`does not match: "${text.slice(0, 60)}"`, () => {
				expect(looksLikeFabricatedModeration(text)).toBe(false);
			});
		}
	});

	describe("guards on empty / short / non-string inputs", () => {
		it("returns false for undefined", () => {
			expect(looksLikeFabricatedModeration(undefined)).toBe(false);
		});
		it("returns false for null", () => {
			expect(looksLikeFabricatedModeration(null)).toBe(false);
		});
		it("returns false for empty string", () => {
			expect(looksLikeFabricatedModeration("")).toBe(false);
		});
		it("returns false for non-string (number)", () => {
			expect(looksLikeFabricatedModeration(123 as unknown as string)).toBe(
				false,
			);
		});
	});
});
