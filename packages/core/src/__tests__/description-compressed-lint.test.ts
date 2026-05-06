import { describe, expect, it } from "vitest";
import {
	lintDescriptionCompressed,
	MAX_DESCRIPTION_LENGTH,
} from "../utils/description-compressed-lint";

describe("lintDescriptionCompressed", () => {
	it("reports a violation for an empty string", () => {
		const result = lintDescriptionCompressed("");
		expect(result.ok).toBe(false);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0]).toMatch(/^empty:/);
	});

	it("reports a violation for whitespace-only input", () => {
		const result = lintDescriptionCompressed("   \n\t  ");
		expect(result.ok).toBe(false);
		expect(result.violations[0]).toMatch(/^empty:/);
	});

	it("accepts a clean imperative description", () => {
		const result = lintDescriptionCompressed("Send a Slack DM to a user.");
		expect(result.ok).toBe(true);
		expect(result.violations).toEqual([]);
	});

	it("accepts a description at exactly the max length", () => {
		const text = `Send msg ${"x".repeat(MAX_DESCRIPTION_LENGTH - 9)}`;
		expect(text.length).toBe(MAX_DESCRIPTION_LENGTH);

		const result = lintDescriptionCompressed(text);
		const lengthViolations = result.violations.filter((v) =>
			v.startsWith("length:"),
		);
		expect(lengthViolations).toEqual([]);
	});

	it("flags a description longer than the max length", () => {
		const text = "Send a msg ".repeat(20);
		expect(text.length).toBeGreaterThan(MAX_DESCRIPTION_LENGTH);

		const result = lintDescriptionCompressed(text);
		expect(result.ok).toBe(false);
		expect(result.violations.some((v) => v.startsWith("length:"))).toBe(true);
	});

	it("flags banned filler phrases regardless of casing", () => {
		const result = lintDescriptionCompressed(
			"Use This Action to send a Slack DM In Order To notify a user.",
		);
		expect(result.ok).toBe(false);

		const phraseHits = result.violations.filter((v) =>
			v.startsWith("banned-phrase:"),
		);
		// "use this action", "this action", "the user" (no — `notify a user`),
		// "in order to" — at least three distinct phrase hits.
		expect(phraseHits.length).toBeGreaterThanOrEqual(3);
		expect(phraseHits.some((v) => v.includes('"in order to"'))).toBe(true);
		expect(phraseHits.some((v) => v.includes('"this action"'))).toBe(true);
	});

	it("flags every banned filler phrase from PHRASE_REPLACEMENTS keys", () => {
		const phrases = [
			"in order to",
			"please",
			"simply",
			"basically",
			"actually",
			"currently",
			"this action",
			"use this action",
			"the user",
			"the agent",
		];
		for (const phrase of phrases) {
			const result = lintDescriptionCompressed(`Send msg ${phrase} now`);
			const hit = result.violations.find(
				(v) => v.startsWith("banned-phrase:") && v.includes(`"${phrase}"`),
			);
			expect(hit, `expected banned-phrase hit for "${phrase}"`).toBeDefined();
		}
	});

	it("flags long-form word forms and suggests the abbreviation", () => {
		const messagesResult = lintDescriptionCompressed(
			"Forward messages between channels.",
		);
		expect(messagesResult.ok).toBe(false);
		expect(
			messagesResult.violations.some(
				(v) => v.startsWith("banned-word:") && v.includes('"messages"'),
			),
		).toBe(true);
		expect(
			messagesResult.violations.some((v) => v.includes('use "msgs" instead')),
		).toBe(true);

		const configResult = lintDescriptionCompressed(
			"Update plugin configuration.",
		);
		expect(configResult.ok).toBe(false);
		expect(
			configResult.violations.some(
				(v) => v.startsWith("banned-word:") && v.includes('"configuration"'),
			),
		).toBe(true);
		expect(
			configResult.violations.some((v) => v.includes('use "config" instead')),
		).toBe(true);
	});

	it("flags non-imperative leading verbs", () => {
		for (const lead of [
			"It",
			"This",
			"Helps",
			"Allows",
			"Should",
			"Provides",
			"Returns",
			"Automatically",
		]) {
			const result = lintDescriptionCompressed(
				`${lead} to do something useful.`,
			);
			const hit = result.violations.find((v) =>
				v.startsWith("non-imperative:"),
			);
			expect(hit, `expected non-imperative hit for "${lead}"`).toBeDefined();
		}
	});

	it("does not flag imperative leads like Send/Get/List/Create", () => {
		for (const lead of ["Send", "Get", "List", "Create", "Route"]) {
			const result = lintDescriptionCompressed(`${lead} a Slack message.`);
			expect(
				result.violations.some((v) => v.startsWith("non-imperative:")),
				`leading "${lead}" should not be flagged as non-imperative`,
			).toBe(false);
		}
	});

	it("returns multiple violations for a description that breaks several rules at once", () => {
		const text = `This action will ${"x".repeat(MAX_DESCRIPTION_LENGTH)} messages configuration basically simply please use this action in order to reach the user and the agent currently.`;
		const result = lintDescriptionCompressed(text);
		expect(result.ok).toBe(false);

		const lengthHits = result.violations.filter((v) => v.startsWith("length:"));
		const phraseHits = result.violations.filter((v) =>
			v.startsWith("banned-phrase:"),
		);
		const wordHits = result.violations.filter((v) =>
			v.startsWith("banned-word:"),
		);
		const leadHits = result.violations.filter((v) =>
			v.startsWith("non-imperative:"),
		);

		expect(lengthHits.length).toBeGreaterThanOrEqual(1);
		expect(phraseHits.length).toBeGreaterThanOrEqual(5);
		expect(wordHits.length).toBeGreaterThanOrEqual(2);
		expect(leadHits.length).toBe(1);
	});
});
