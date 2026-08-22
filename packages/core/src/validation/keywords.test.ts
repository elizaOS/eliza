/**
 * Deterministic pure coverage for action keyword validation over current and
 * recent message text; no runtime, provider, or database harness is used.
 */
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
				memory("Please connect  Discord  "),
				[],
				["", " discord "],
			),
		).toBe(true);
		expect(
			validateActionKeywords(memory("Please connect"), [], ["", "slack"]),
		).toBe(false);
	});

	it("returns false when current and recent messages have no text", () => {
		expect(
			validateActionKeywords(
				memory(),
				[memory(), memory(undefined)],
				["hello"],
			),
		).toBe(false);
	});

	it("retains the current and every recent message", () => {
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
		).toBe(true);
	});
});
