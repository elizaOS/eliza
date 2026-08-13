import { describe, expect, it } from "vitest";
import type { Memory } from "../types";
import { validateActionKeywords } from "./keywords.ts";

const memory = (text?: string) => ({ content: { text } }) as Memory;

describe("validateActionKeywords", () => {
	it("does not match empty or whitespace-only keywords", () => {
		expect(validateActionKeywords(memory("hello"), [], [""])).toBe(false);
		expect(validateActionKeywords(memory("hello"), [], ["   "])).toBe(false);
	});

	it("ignores empty entries while matching meaningful keywords", () => {
		expect(
			validateActionKeywords(
				memory("Please connect Discord"),
				[],
				["", " discord "],
			),
		).toBe(true);
		expect(
			validateActionKeywords(memory("Please connect"), [], ["", "slack"]),
		).toBe(false);
	});

	it("retains the current and last five recent messages", () => {
		const recentMessages = [
			memory("old message 1"),
			memory("old message 2"),
			memory("old message 3"),
			memory("old message 4"),
			memory("old message 5"),
			memory("recent connector message"),
		];

		expect(
			validateActionKeywords(memory("current"), recentMessages, ["connector"]),
		).toBe(true);
		expect(
			validateActionKeywords(memory("current"), recentMessages, [
				"old message 1",
			]),
		).toBe(false);
	});
});
